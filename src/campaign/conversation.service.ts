import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService, CampaignSession, CampaignMessage } from '../sessions/sessions.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import {
  CampaignPatientStatus,
  ComplaintSeverity,
  ComplaintType,
  ConversationOutcome,
  Language,
  MessageKey,
} from '@prisma/client';

// ─── Anthropic API shapes ─────────────────────────────────────────────────────

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | string;
  usage: { input_tokens: number; output_tokens: number };
}

// ─── Tool input shapes ────────────────────────────────────────────────────────

interface LogComplaintInput {
  type: ComplaintType;
  severity: ComplaintSeverity;
  summary: string;
}

interface RequestBookingInput {
  preferredDoctor?: string;
  preferredDateRange?: string;
  reason?: string;
}

interface RequestHandoffInput {
  reason: string;
}

interface EndConversationInput {
  outcome: ConversationOutcome;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const CLAUDE_TOOLS = [
  {
    name: 'log_complaint',
    description:
      'Log a patient complaint or medical concern. ' +
      'Call this whenever the patient expresses dissatisfaction, criticises the service, ' +
      'reports a health problem, or describes an urgent situation. ' +
      'This is a silent side effect — always follow it with a warm human text response.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['COMPLAINT', 'MEDICAL_CONCERN', 'URGENT'],
          description:
            'COMPLAINT = service/experience complaint. ' +
            'MEDICAL_CONCERN = health issue the patient is reporting. ' +
            'URGENT = emergency that needs immediate staff attention.',
        },
        severity: {
          type: 'string',
          enum: ['LOW', 'MEDIUM', 'HIGH'],
          description:
            'LOW = minor issue. MEDIUM = significant concern. ' +
            'HIGH = serious situation requiring urgent staff action.',
        },
        summary: {
          type: 'string',
          description:
            'A clear 1-2 sentence summary written in the same language the patient used.',
        },
      },
      required: ['type', 'severity', 'summary'],
    },
  },
  {
    name: 'request_booking',
    description:
      'Create a booking request when the patient wants to schedule a new appointment. ' +
      'This is a silent side effect — always follow it with a warm confirmation to the patient.',
    input_schema: {
      type: 'object',
      properties: {
        preferredDoctor: {
          type: 'string',
          description: 'Doctor name if the patient mentioned one.',
        },
        preferredDateRange: {
          type: 'string',
          description: 'Date preference as the patient expressed it, e.g. "semaine prochaine", "next Monday".',
        },
        reason: {
          type: 'string',
          description: 'Reason for the new appointment as the patient expressed it.',
        },
      },
      required: [],
    },
  },
  {
    name: 'request_handoff',
    description:
      'Transfer the conversation to a human staff member. ' +
      'Use when: the patient explicitly asks for a human, the patient is very distressed, ' +
      'the situation is medically complex, or severity is HIGH. ' +
      'IMPORTANT: If the patient complained AND wants a human, call log_complaint first, then request_handoff. ' +
      'This ends the AI conversation — always send a warm farewell text before calling this.',
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Clear explanation for the staff member who will take over.',
        },
      },
      required: ['reason'],
    },
  },
  {
    name: 'end_conversation',
    description:
      'Close the conversation when the follow-up is complete. ' +
      'Use when: the patient has no more concerns, they have been helped, or they have disengaged. ' +
      'Always send a warm farewell text to the patient before calling this tool.',
    input_schema: {
      type: 'object',
      properties: {
        outcome: {
          type: 'string',
          enum: ['COMPLETED', 'COMPLAINED', 'REBOOKED', 'HANDED_OFF', 'URGENT', 'OPTED_OUT', 'NO_RESPONSE'],
          description: 'The final outcome of this conversation.',
        },
      },
      required: ['outcome'],
    },
  },
];

// ─── Constants ────────────────────────────────────────────────────────────────

const ANTHROPIC_MODEL = 'claude-haiku-4-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;
const MAX_TOOL_LOOPS = 6;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);
  private readonly anthropicApiKey: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly sessionsService: SessionsService,
    private readonly whatsappService: WhatsAppService,
  ) {
    const key = this.configService.get<string>('anthropic.apiKey');
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
    this.anthropicApiKey = key;
    this.logger.log(`ConversationService initialized — model: ${ANTHROPIC_MODEL}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC ENTRY POINT
  // ═══════════════════════════════════════════════════════════════════════════

  async handleReply(phone: string, patientMessage: string): Promise<void> {
    this.logger.log(`Campaign reply from ${phone}: "${patientMessage}"`);

    // ── 1. Load Redis session ──────────────────────────────────────────────
    const session = await this.sessionsService.getCampaignSession(phone);
    if (!session) {
      this.logger.error(`No campaign session found for ${phone}`);
      return;
    }

    // ── 2. Session status guard ────────────────────────────────────────────
    if (session.status === 'completed') {
      this.logger.warn(`Session for ${phone} is completed — ignoring`);
      return;
    }

    if (session.status === 'handed_off') {
      this.logger.log(`Session for ${phone} is handed off to staff — AI ignoring reply`);
      return;
    }

    // ── 3. Load CampaignPatient ────────────────────────────────────────────
    const campaignPatient = await this.prisma.campaignPatient.findUnique({
      where: { id: session.campaignPatientId },
      include: { campaign: true },
    });

    if (!campaignPatient) {
      this.logger.error(
        `CampaignPatient ${session.campaignPatientId} not found — purging orphaned session`,
      );
      await this.sessionsService.deleteCampaignSession(phone);
      return;
    }

    // ── 4. Load clinic ─────────────────────────────────────────────────────
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: session.clinicId },
    });

    if (!clinic) {
      this.logger.error(`Clinic ${session.clinicId} not found`);
      return;
    }

    // ── 5. Language detection ──────────────────────────────────────────────
    // Re-detect on every message so the patient can switch languages at any time.
    // Explicit switch phrases ("speak english", "parle en français") always win.
    // Short ambiguous messages fall back to the current session language.
    const detectedLang = this.detectLanguage(patientMessage);
    const resolvedLang = detectedLang ?? session.language ?? Language.FR;

    if (session.language !== resolvedLang) {
      session.language = resolvedLang;
      await this.prisma.campaignPatient.update({
        where: { id: campaignPatient.id },
        data: { language: resolvedLang },
      });
      this.logger.log(`Language updated for ${phone}: ${resolvedLang}`);
    }

    // ── 6. Mark REPLIED on first reply ────────────────────────────────────
    if (campaignPatient.status === CampaignPatientStatus.CONTACTED) {
      await this.prisma.campaignPatient.update({
        where: { id: campaignPatient.id },
        data: { status: CampaignPatientStatus.REPLIED, repliedAt: new Date() },
      });
      await this.prisma.campaign.update({
        where: { id: campaignPatient.campaignId },
        data: { repliedCount: { increment: 1 } },
      });
    }

    // ── 7. Activate session ────────────────────────────────────────────────
    session.status = 'active';

    // ── 8. Append patient message ──────────────────────────────────────────
    const isDuplicate = session.messages.some(
      m => m.role === 'user' && m.content === patientMessage && Date.now() - m.timestamp < 10_000,
    );
    if (!isDuplicate) {
      session.messages.push({ role: 'user', content: patientMessage, timestamp: Date.now() });
    }

    // ── 9. Resolve aiMaxTurns ──────────────────────────────────────────────
    const aiMaxTurns = campaignPatient.campaign?.aiMaxTurns ?? clinic.aiMaxTurns;

    // ── 10. Auto-close on turn limit ───────────────────────────────────────
    if (session.turnCount >= aiMaxTurns) {
      this.logger.warn(`Turn limit (${aiMaxTurns}) reached for ${phone} — closing`);
      const farewell = await this.fetchBotMessage(clinic.id, MessageKey.CAMPAIGN_FAREWELL_MESSAGE, session.language ?? Language.FR);
      if (farewell) await this.whatsappService.sendText(phone, farewell);
      await this.closeConversation(session, campaignPatient.id, campaignPatient.campaignId, ConversationOutcome.COMPLETED);
      return;
    }

    // ── 11. Build prompt and run Claude tool loop ──────────────────────────
    const systemPrompt = this.buildSystemPrompt(session, campaignPatient, clinic);
    const claudeMessages = this.buildClaudeMessages(session);

    let conversationEnded = false;
    let loopCount = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    while (loopCount < MAX_TOOL_LOOPS && !conversationEnded) {
      let response: AnthropicMessage;

      try {
        response = await this.callClaudeWithRetry(systemPrompt, claudeMessages);
      } catch (err: any) {
        this.logger.error(`Claude call failed for ${phone}: ${err.message}`);
        const errMsg = (session.language ?? Language.FR) === Language.EN
          ? 'Sorry, I encountered a technical issue. Please try again in a few minutes.'
          : 'Désolé, je rencontre un problème technique. Veuillez réessayer dans quelques minutes.';
        await this.whatsappService.sendText(phone, errMsg);
        return;
      }

      if (response.stop_reason === 'max_tokens') {
        // Never send a truncated mid-sentence response to the patient.
        // Always send a clean neutral fallback and keep the session alive
        // so the patient can reply and get a fresh response next turn.
        this.logger.warn(`Claude response truncated (max_tokens) for ${phone} — sending clean fallback`);
        const fallback = (session.language ?? Language.FR) === Language.EN
          ? 'Sorry, something came up on my end. Could you repeat that?'
          : 'Désolé, une erreur est survenue de mon côté. Pouvez-vous répéter ?';
        await this.whatsappService.sendText(phone, fallback);
        await this.sessionsService.saveCampaignSession(session);
        return;
      }

      if (response.usage) {
        totalInputTokens += response.usage.input_tokens;
        totalOutputTokens += response.usage.output_tokens;
      }

      const textBlocks = response.content
        .filter((b): b is AnthropicTextBlock => b.type === 'text' && b.text.trim().length > 0);

      const toolUseBlocks = response.content
        .filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use');

      const toolResults: { type: 'tool_result'; tool_use_id: string; content: string }[] = [];

      for (const toolBlock of toolUseBlocks) {
        this.logger.log(`Tool: ${toolBlock.name} — ${JSON.stringify(toolBlock.input)}`);

        let resultContent = 'Success';
        try {
          if (toolBlock.name === 'log_complaint') {
            await this.executeLogComplaint(
              toolBlock.input as unknown as LogComplaintInput,
              campaignPatient.id,
              clinic.id,
              patientMessage,
              campaignPatient.campaignId,
              clinic,
            );
            resultContent = 'Complaint logged successfully.';

          } else if (toolBlock.name === 'request_booking') {
            await this.executeRequestBooking(
              toolBlock.input as unknown as RequestBookingInput,
              campaignPatient.id,
              clinic.id,
              patientMessage,
            );
            resultContent = 'Booking request recorded.';

          } else if (toolBlock.name === 'request_handoff') {
            if (textBlocks.length > 0) {
              const textReply = textBlocks.map(b => b.text).join('\n\n').trim();
              await this.whatsappService.sendText(phone, textReply);
              session.messages.push({ role: 'assistant', content: textReply, timestamp: Date.now() });
            }
            await this.executeRequestHandoff(
              toolBlock.input as unknown as RequestHandoffInput,
              session,
              campaignPatient.id,
              campaignPatient.campaignId,
              clinic,
            );
            resultContent = 'Handoff executed.';
            conversationEnded = true;

          } else if (toolBlock.name === 'end_conversation') {
            if (textBlocks.length > 0) {
              const textReply = textBlocks.map(b => b.text).join('\n\n').trim();
              await this.whatsappService.sendText(phone, textReply);
              session.messages.push({ role: 'assistant', content: textReply, timestamp: Date.now() });
            }
            await this.closeConversation(
              session,
              campaignPatient.id,
              campaignPatient.campaignId,
              (toolBlock.input as unknown as EndConversationInput).outcome,
            );
            resultContent = 'Conversation closed.';
            conversationEnded = true;
          }
        } catch (err: any) {
          this.logger.error(`Tool ${toolBlock.name} failed: ${err.message}`);
          resultContent = `Error: ${err.message}`;
        }

        toolResults.push({ type: 'tool_result', tool_use_id: toolBlock.id, content: resultContent });
      }

      if (toolUseBlocks.length === 0 || conversationEnded) {
        if (!conversationEnded && textBlocks.length > 0) {
          const textReply = textBlocks.map(b => b.text).join('\n\n').trim();
          await this.whatsappService.sendText(phone, textReply);
          session.messages.push({ role: 'assistant', content: textReply, timestamp: Date.now() });
        }
        break;
      }

      claudeMessages.push({ role: 'assistant', content: response.content as any });
      claudeMessages.push({ role: 'user', content: toolResults as any });

      session.messages.push({
        role: 'assistant',
        content: JSON.stringify(response.content),
        timestamp: Date.now(),
      });
      session.messages.push({
        role: 'user',
        content: JSON.stringify(toolResults),
        timestamp: Date.now(),
      });

      loopCount++;
    }

    // ── 12. Increment turn count ───────────────────────────────────────────
    session.turnCount += 1;

    // ── 13. Log token usage ────────────────────────────────────────────────
    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      try {
        await this.prisma.aiUsage.create({
          data: {
            campaignPatientId: campaignPatient.id,
            clinicId: clinic.id,
            campaignId: campaignPatient.campaignId,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            model: ANTHROPIC_MODEL,
          },
        });
      } catch (err: any) {
        this.logger.warn(`Failed to log token usage: ${err.message}`);
      }
    }

    // ── 14. Persist to DB ──────────────────────────────────────────────────
    await this.prisma.campaignPatient.update({
      where: { id: campaignPatient.id },
      data: {
        messages: session.messages as any,
        turnCount: session.turnCount,
      },
    });

    // ── 15. Save session to Redis unless ended ─────────────────────────────
    if (!conversationEnded) {
      await this.sessionsService.saveCampaignSession(session);
    }

    this.logger.log(`Turn ${session.turnCount}/${aiMaxTurns} complete for ${phone}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SYSTEM PROMPT
  // ═══════════════════════════════════════════════════════════════════════════

  private buildSystemPrompt(
    session: CampaignSession,
    campaignPatient: {
      patientSnapshot: any;
      patientName: string;
      visitDate: Date;
      prestation: string;
      medecinTraitant: string;
      ageYears: number | null;
      sexe: string | null;
      ville: string | null;
    },
    clinic: {
      name: string;
      phone: string;
      address?: string | null;
      notificationPhone?: string | null;
    },
  ): string {
    const language = session.language ?? Language.FR;
    const snapshot = campaignPatient.patientSnapshot as Record<string, any>;
    const historyData = snapshot?.history ?? null;

    // ── Language instruction ───────────────────────────────────────────────
    // Single clear rule: match the patient's detected language.
    // No contradictory lock — the patient owns the language choice.
    const languageInstruction = language === Language.EN
      ? 'LANGUAGE: The patient is communicating in English. Respond in English.\n' +
        'If the patient switches to French at any point, switch to French immediately.\n' +
        'If the patient explicitly asks you to speak a specific language, switch immediately and confirm it.\n' +
        'Only French (FR) and English (EN) are supported. If the patient writes in any other language, respond in French.'
      : 'LANGUE: Le patient communique en français. Répondez en français.\n' +
        'Si le patient passe à l\'anglais à tout moment, passez immédiatement à l\'anglais.\n' +
        'Si le patient vous demande explicitement de parler dans une langue spécifique, changez immédiatement et confirmez-le.\n' +
        'Seuls le français (FR) et l\'anglais (EN) sont pris en charge. Si le patient écrit dans une autre langue, répondez en français.';

    // ── Patient history ────────────────────────────────────────────────────
    let historySection = 'Aucun historique disponible.';
    if (
      historyData?.admissions &&
      Array.isArray(historyData.admissions) &&
      historyData.admissions.length > 0
    ) {
      const lines = historyData.admissions
        .slice(0, 10)
        .map((a: any, i: number) => {
          const date = a.date_admission
            ? new Date(a.date_admission).toLocaleDateString('fr-FR')
            : 'Date inconnue';
          const motif = a.motif_admission ?? 'Inconnu';
          const doctor = a.medecin_traitant ?? 'Inconnu';
          const actes =
            Array.isArray(a.actes_realises) && a.actes_realises.length > 0
              ? a.actes_realises.join(', ')
              : 'Aucun acte enregistré';
          return `  ${i + 1}. ${date} — ${motif} (Dr. ${doctor}) | Actes: ${actes}`;
        })
        .join('\n');
      const solde = historyData.solde_impaye ?? 0;
      historySection = `Admissions précédentes :\n${lines}\nSolde impayé : ${solde} MAD`;
    }

    const visitDate = new Date(campaignPatient.visitDate).toLocaleDateString('fr-FR');
    const today = new Date().toLocaleDateString('fr-FR');

    return `You are a compassionate, professional medical follow-up assistant for ${clinic.name}.

${languageInstruction}

TODAY: ${today}

FORMATTING RULES:
- Never use emojis.
- Keep every message to 2-4 sentences maximum. This is WhatsApp, not email.
- Never ask more than one question per message.
- Never invent medical advice or diagnoses.
- Never mention other patients.
- DO NOT use time-specific greetings like "Bonjour" (morning), "Bonsoir" (evening), "Good morning", "Good evening". Use time-neutral greetings like "Salut" (French) or "Hello" (English).

PATIENT INFORMATION:
- Name: ${campaignPatient.patientName}
- Age: ${campaignPatient.ageYears ?? 'Unknown'}
- Sex: ${campaignPatient.sexe ?? 'Unknown'}
- City: ${campaignPatient.ville ?? 'Unknown'}
- Last visit date: ${visitDate}
- Reason for last visit: ${campaignPatient.prestation}
- Treating doctor: ${campaignPatient.medecinTraitant}

PATIENT HISTORY:
${historySection}

CLINIC CONTACT:
- Phone: ${clinic.phone}${clinic.address ? `\n- Address: ${clinic.address}` : ''}

YOUR GOAL:
Follow up on the patient's wellbeing after their recent visit. Listen to their concerns, acknowledge them warmly, and take appropriate action using the tools available.

TOOL USAGE RULES — READ CAREFULLY:

1. log_complaint
   - Call this when the patient expresses ANY dissatisfaction, complaint, health concern, or urgency.
   - This is a SILENT side effect. After calling it, you MUST send a warm, empathetic text response to the patient acknowledging their concern. Do NOT tell the patient you "logged" anything.
   - IDEMPOTENCY: Only call this once per distinct issue. If you already called it for this issue and received a success response, do NOT call it again.

2. request_booking
   - Call this when the patient wants to book a new appointment.
   - This is a SILENT side effect. After calling it, confirm warmly in text that their request has been noted and that the team will follow up.
   - IDEMPOTENCY: Only call this once per booking request.

3. request_handoff
   - Call this when the patient explicitly asks for a human, is very distressed, or the situation is HIGH severity.
   - IMPORTANT: If the patient also complained, call log_complaint FIRST, then request_handoff.
   - Before calling this tool, send a warm farewell text to the patient telling them a staff member will be in touch.
   - This ENDS the AI conversation permanently.

4. end_conversation
   - Call this when the conversation has reached a natural end.
   - Before calling this tool, send a warm farewell text to the patient.
   - This ENDS the AI conversation permanently.

CONVERSATION FLOW:
- Turn 1: Warm greeting, ask how they are doing since their visit.
- Turn 2: If they say they are fine, acknowledge warmly and ask ONE follow-up question (e.g. any remaining questions about their treatment, or whether they need to rebook). Do NOT close yet.
- Turn 3+: If they confirm everything is fine with no further needs, THEN close warmly with end_conversation.
- If they have a concern at any point: Listen, acknowledge, use tools, respond warmly.
- If they want to stop or say goodbye explicitly: Respect it immediately. Use end_conversation after a polite farewell.
- If they are rude or clearly done talking: Close gracefully with end_conversation.

IMPORTANT — DO NOT close the conversation after a single positive reply like "I'm fine" or "yeah all good".
The patient may still have questions or need a follow-up appointment. Always ask one gentle follow-up before closing.
Only use end_conversation when the patient has clearly indicated they have nothing more to discuss.

CRITICAL — NEVER use end_conversation because the patient sends a short or repeated message like "hi", "ok", "yeah", "hello", or any single word.
These are engagement signals, not goodbyes. The patient is still present and talking.
Only close when the patient explicitly says goodbye ("bye", "merci au revoir", "that's all", "c'est tout") or after confirming they have no further questions or concerns.

Current turn: ${session.turnCount + 1}`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUILD CLAUDE MESSAGES ARRAY
  // ═══════════════════════════════════════════════════════════════════════════

  private buildClaudeMessages(
    session: CampaignSession,
  ): { role: 'user' | 'assistant'; content: any }[] {
    return session.messages
      .filter(m => m.content?.trim())
      .map(m => {
        let content: any = m.content;
        if (
          typeof m.content === 'string' &&
          (m.content.trim().startsWith('[') || m.content.trim().startsWith('{'))
        ) {
          try {
            content = JSON.parse(m.content);
          } catch {
            // Keep as string if parse fails
          }
        }
        return { role: m.role, content };
      });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CALL CLAUDE WITH RETRY
  // ═══════════════════════════════════════════════════════════════════════════

  private async callClaudeWithRetry(
    systemPrompt: string,
    messages: { role: 'user' | 'assistant'; content: any }[],
  ): Promise<AnthropicMessage> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.callClaude(systemPrompt, messages);
      } catch (err: any) {
        lastError = err;
        const isRetryable =
          err.message.includes('529') ||
          err.message.includes('500') ||
          err.message.includes('503');

        if (isRetryable && attempt < MAX_RETRIES) {
          this.logger.warn(`Anthropic API error — retrying (${attempt + 1}/${MAX_RETRIES}): ${err.message}`);
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        throw err;
      }
    }

    throw lastError!;
  }

  private async callClaude(
    systemPrompt: string,
    messages: { role: 'user' | 'assistant'; content: any }[],
  ): Promise<AnthropicMessage> {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.anthropicApiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        tools: CLAUDE_TOOLS,
        messages,
      }),
    });

    if (!response.ok) {
      let errorBody = '';
      try { errorBody = JSON.stringify(await response.json()); }
      catch { errorBody = await response.text().catch(() => ''); }
      throw new Error(`Anthropic API error ${response.status}: ${errorBody}`);
    }

    return response.json() as Promise<AnthropicMessage>;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL EXECUTORS
  // ═══════════════════════════════════════════════════════════════════════════

  private async executeLogComplaint(
    input: LogComplaintInput,
    campaignPatientId: string,
    clinicId: string,
    triggeringMessage: string,
    campaignId: string,
    clinic: { id: string; notificationPhone?: string | null },
  ): Promise<void> {
    await this.prisma.complaint.create({
      data: {
        campaignPatientId,
        clinicId,
        type: input.type,
        severity: input.severity,
        triggeringMessage,
        summary: input.summary,
      },
    });

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { complainedCount: { increment: 1 } },
    });

    if (input.severity === ComplaintSeverity.HIGH && clinic.notificationPhone) {
      try {
        await this.whatsappService.sendText(
          clinic.notificationPhone,
          `ALERTE PLAINTE GRAVE\nPatient: ${campaignPatientId}\nType: ${input.type}\nRésumé: ${input.summary}\nAction requise immédiatement.`,
        );
      } catch (err: any) {
        this.logger.error(`Failed to send HIGH complaint alert: ${err.message}`);
      }
    }

    this.logger.log(`Complaint logged: ${input.type}/${input.severity} for patient ${campaignPatientId}`);
  }

  private async executeRequestBooking(
    input: RequestBookingInput,
    campaignPatientId: string,
    clinicId: string,
    rawPatientMessage: string,
  ): Promise<void> {
    await this.prisma.bookingRequest.create({
      data: {
        campaignPatientId,
        clinicId,
        preferredDoctor: input.preferredDoctor ?? null,
        preferredDateRange: input.preferredDateRange ?? null,
        reason: input.reason ?? null,
        rawPatientRequest: rawPatientMessage,
      },
    });

    this.logger.log(`Booking request created for patient ${campaignPatientId}`);
  }

  private async executeRequestHandoff(
    input: RequestHandoffInput,
    session: CampaignSession,
    campaignPatientId: string,
    campaignId: string,
    clinic: { id: string; notificationPhone?: string | null },
  ): Promise<void> {
    session.status = 'handed_off';

    await this.prisma.campaignPatient.update({
      where: { id: campaignPatientId },
      data: {
        status: CampaignPatientStatus.COMPLETED,
        outcome: ConversationOutcome.HANDED_OFF,
        completedAt: new Date(),
      },
    });

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { completedCount: { increment: 1 } },
    });

    await this.sessionsService.saveCampaignSession(session);
    await this.sessionsService.delete(session.phone);

    if (clinic.notificationPhone) {
      try {
        await this.whatsappService.sendText(
          clinic.notificationPhone,
          `TRANSFERT REQUIS\nPatient: ${session.phone}\nRaison: ${input.reason}\nPrenez en charge ce patient.`,
        );
      } catch (err: any) {
        this.logger.error(`Failed to notify staff of handoff: ${err.message}`);
      }
    }

    this.logger.log(`Handoff executed for patient ${campaignPatientId} — session kept alive for staff`);
  }

  private async closeConversation(
    session: CampaignSession,
    campaignPatientId: string,
    campaignId: string,
    outcome: ConversationOutcome,
  ): Promise<void> {
    session.status = 'completed';

    await this.prisma.campaignPatient.update({
      where: { id: campaignPatientId },
      data: {
        status: CampaignPatientStatus.COMPLETED,
        outcome,
        completedAt: new Date(),
      },
    });

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { completedCount: { increment: 1 } },
    });

    await this.sessionsService.deleteCampaignSession(session.phone);
    await this.sessionsService.delete(session.phone);

    this.logger.log(`Conversation closed for patient ${campaignPatientId} — outcome: ${outcome}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Detects language from a patient message.
   *
   * Priority:
   *   1. Explicit switch phrases ("speak english", "parle en français") — always wins
   *   2. Whole-word keyword scoring — word-boundary regex avoids false matches
   *      e.g. "hi" won't match inside "jehilal", "no" won't match inside "bonjour"
   *   3. Returns FR on tie or zero score (Moroccan clinic default)
   *
   * Short messages (< 3 chars) are returned as FR — caller uses current session
   * language in that case so the response stays consistent.
   */
  private detectLanguage(message: string): Language {
    const lower = message.toLowerCase().trim();

    // ── 1. Explicit language-switch phrases — highest priority ─────────────
    const explicitEN = [
      'speak english', 'in english', 'switch to english', 'respond in english',
      'reply in english', 'english please', 'please english', 'en anglais',
      'talk to me in english', 'write in english',
    ];
    const explicitFR = [
      'parle français', 'parle en français', 'en français', 'réponds en français',
      'switch to french', 'respond in french', 'reply in french', 'french please',
      'parle en francais', 'en francais', 'réponds en francais',
    ];

    if (explicitEN.some(p => lower.includes(p))) return Language.EN;
    if (explicitFR.some(p => lower.includes(p))) return Language.FR;

    // ── 2. Very short messages — fall back to FR default ───────────────────
    if (lower.length < 3) return Language.FR;

    // ── 3. Whole-word keyword scoring ──────────────────────────────────────
    const frWords = [
      'bonjour', 'bonsoir', 'salut', 'merci', 'oui', 'non', 'bien',
      'comment', 'ça va', 'ca va', 'salam', 'très', 'pour', 'avec',
      'dans', 'vous', 'nous', 'est-ce', "j'ai", "c'est", 'pas', 'je',
      'quoi', 'rien', 'tout', 'encore', 'maintenant', 'vraiment',
    ];
    const enWords = [
      'hello', 'hi', 'hey', 'thanks', 'thank you', 'thank', 'yes', 'yeah',
      'good', 'fine', 'okay', 'ok', 'please', 'help', 'what', 'when',
      'where', 'how', "i'm", 'i am', 'i have', 'i need',
      'great', 'sure', 'no', 'not', 'done', 'right', 'got it',
    ];

    // Word-boundary matcher — escapes special regex chars in the keyword
    const wb = (word: string) =>
      new RegExp(
        `(?<![a-zàâçéèêëîïôûùüÿæœ])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-zàâçéèêëîïôûùüÿæœ])`,
        'i',
      );

    const frScore = frWords.filter(w => wb(w).test(lower)).length;
    const enScore = enWords.filter(w => wb(w).test(lower)).length;

    if (enScore > frScore) return Language.EN;
    if (frScore > enScore) return Language.FR;

    // ── 4. Tie or zero score — default FR ──────────────────────────────────
    return Language.FR;
  }

  /**
   * Fetches a bot message body from DB with FR fallback.
   * Replaces common template variables.
   */
  async fetchBotMessage(
    clinicId: string,
    key: MessageKey,
    language: Language,
    variables?: Record<string, string>,
  ): Promise<string | null> {
    const record = await this.prisma.botMessage.findUnique({
      where: { clinicId_key_language: { clinicId, key, language } },
    });

    let body = record?.body ?? null;

    if (!body && language !== Language.FR) {
      const fallback = await this.prisma.botMessage.findUnique({
        where: { clinicId_key_language: { clinicId, key, language: Language.FR } },
      });
      body = fallback?.body ?? null;
    }

    if (body && variables) {
      for (const [k, v] of Object.entries(variables)) {
        body = body.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
      }
    }

    return body;
  }
}