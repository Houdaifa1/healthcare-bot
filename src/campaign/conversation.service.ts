import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService, CampaignSession, CampaignMessage } from '../sessions/sessions.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import {
  CampaignPatientStatus,
  ComplaintType,
  ComplaintSeverity,
  ConversationOutcome,
  Language,
  MessageKey,
} from '@prisma/client';

// ─── Anthropic API types ───────────────────────────────────────────────────────

interface AnthropicTextBlock {
  type:  'text';
  text:  string;
}

interface AnthropicToolUseBlock {
  type:  'tool_use';
  id:    string;
  name:  string;
  input: Record<string, unknown>;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicMessage {
  id:           string;
  type:         'message';
  role:         'assistant';
  content:      AnthropicContentBlock[];
  stop_reason:  'end_turn' | 'tool_use' | 'max_tokens' | string;
  usage:        { input_tokens: number; output_tokens: number };
}

// ─── Tool input shapes ────────────────────────────────────────────────────────

interface LogComplaintInput {
  type:     ComplaintType;
  severity: ComplaintSeverity;
  summary:  string;
}

interface RequestBookingInput {
  preferredDoctor?:    string;
  preferredDateRange?: string;
  reason?:             string;
}

interface RequestHandoffInput {
  reason: string;
}

interface EndConversationInput {
  outcome: ConversationOutcome;
}

// ─── Claude tool definitions ──────────────────────────────────────────────────

const CLAUDE_TOOLS = [
  {
    name:        'log_complaint',
    description: 'Log a patient complaint or medical concern detected in the conversation. Call this whenever the patient expresses dissatisfaction, reports a medical issue, or describes an urgent situation.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['COMPLAINT', 'MEDICAL_CONCERN', 'URGENT'],
          description: 'COMPLAINT = service/experience complaint, MEDICAL_CONCERN = health issue, URGENT = emergency requiring immediate attention',
        },
        severity: {
          type: 'string',
          enum: ['LOW', 'MEDIUM', 'HIGH'],
          description: 'LOW = minor inconvenience, MEDIUM = significant issue, HIGH = serious concern requiring urgent staff attention',
        },
        summary: {
          type: 'string',
          description: 'A clear 1-2 sentence summary of the complaint in the language the patient used',
        },
      },
      required: ['type', 'severity', 'summary'],
    },
  },
  {
    name:        'request_booking',
    description: 'Create a booking request when the patient expresses intent to schedule a new appointment or follow-up visit.',
    input_schema: {
      type: 'object',
      properties: {
        preferredDoctor: {
          type: 'string',
          description: 'Doctor name if the patient mentioned a preference',
        },
        preferredDateRange: {
          type: 'string',
          description: 'Free text date preference as expressed by the patient, e.g. "semaine prochaine", "lundi matin", "next week"',
        },
        reason: {
          type: 'string',
          description: 'Reason for the new appointment as expressed by the patient',
        },
      },
      required: [],
    },
  },
  {
    name:        'request_handoff',
    description: 'Transfer the conversation to a human staff member. Use when the patient is very distressed, the situation is too complex for AI, the patient explicitly asks for a human, or there is an urgent medical situation.',
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Clear explanation of why handoff is needed, for the staff member who will take over',
        },
      },
      required: ['reason'],
    },
  },
  {
    name:        'end_conversation',
    description: 'Close the conversation when the follow-up is complete. Call this when the patient has no more concerns, has been helped, or has clearly disengaged.',
    input_schema: {
      type: 'object',
      properties: {
        outcome: {
          type: 'string',
          enum: ['COMPLETED', 'COMPLAINED', 'REBOOKED', 'HANDED_OFF', 'URGENT', 'OPTED_OUT', 'NO_RESPONSE'],
          description: 'The final outcome of this conversation',
        },
      },
      required: ['outcome'],
    },
  },
];

// ─── Anthropic model ──────────────────────────────────────────────────────────

const ANTHROPIC_MODEL   = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);
  private readonly anthropicApiKey: string;

  constructor(
    private readonly configService:  ConfigService,
    private readonly prisma:         PrismaService,
    private readonly sessionsService: SessionsService,
    private readonly whatsappService: WhatsAppService,
  ) {
    const key = this.configService.get<string>('anthropic.apiKey');
    if (!key) {
      throw new Error('ANTHROPIC_API_KEY is not set');
    }
    this.anthropicApiKey = key;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC ENTRY POINT — called by MessageProcessor
  // ═══════════════════════════════════════════════════════════════════════════

  async handleReply(phone: string, patientMessage: string): Promise<void> {
    this.logger.log(`Campaign reply from ${phone}: "${patientMessage}"`);

    // ── 1. Load Redis session ──────────────────────────────────────────────
    const session = await this.sessionsService.getCampaignSession(phone);
    if (!session) {
      this.logger.error(`No campaign session found for ${phone} — cannot handle reply`);
      return;
    }

    // ── 2. Guard: session already closed ──────────────────────────────────
    if (session.status === 'completed' || session.status === 'handed_off') {
      this.logger.warn(
        `Campaign session for ${phone} is already ${session.status} — ignoring reply`,
      );
      return;
    }

    // ── 3. Load CampaignPatient from DB ────────────────────────────────────
    const campaignPatient = await this.prisma.campaignPatient.findUnique({
      where: { id: session.campaignPatientId },
    });

    if (!campaignPatient) {
      this.logger.error(
        `CampaignPatient ${session.campaignPatientId} not found for phone ${phone}`,
      );
      return;
    }

    // ── 4. Load clinic for aiMaxTurns and language settings ────────────────
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: session.clinicId },
    });

    if (!clinic) {
      this.logger.error(`Clinic ${session.clinicId} not found`);
      return;
    }

    // ── 5. Detect and persist language on first reply ─────────────────────
    // Language is null until the patient's first message — detect it here
    // and save it to both session and DB so reminders use the right language.
    if (session.language === null) {
      const detected = this.detectLanguage(patientMessage);
      session.language = detected;

      await this.prisma.campaignPatient.update({
        where: { id: campaignPatient.id },
        data:  { language: detected },
      });

      this.logger.log(`Language detected for ${phone}: ${detected}`);
    }

    // ── 6. Mark as REPLIED on first reply ─────────────────────────────────
    if (campaignPatient.status === CampaignPatientStatus.CONTACTED) {
      await this.prisma.campaignPatient.update({
        where: { id: campaignPatient.id },
        data: {
          status:    CampaignPatientStatus.REPLIED,
          repliedAt: new Date(),
        },
      });

      // Increment campaign repliedCount
      await this.prisma.campaign.update({
        where: { id: campaignPatient.campaignId },
        data:  { repliedCount: { increment: 1 } },
      });
    }

    // ── 7. Update session status to active ────────────────────────────────
    session.status = 'active';

    // ── 8. Append patient message to session ──────────────────────────────
    const userMessage: CampaignMessage = {
      role:      'user',
      content:   patientMessage,
      timestamp: Date.now(),
    };
    session.messages.push(userMessage);

    // ── 9. Resolve aiMaxTurns ──────────────────────────────────────────────
    const aiMaxTurns = await this.resolveAiMaxTurns(campaignPatient.campaignId, clinic.aiMaxTurns);

    // ── 10. Auto-close if turn limit reached ──────────────────────────────
    if (session.turnCount >= aiMaxTurns) {
      this.logger.warn(
        `Turn limit (${aiMaxTurns}) reached for ${phone} — auto-closing conversation`,
      );
      await this.closeConversation(session, campaignPatient.id, campaignPatient.campaignId, ConversationOutcome.COMPLETED);
      return;
    }

    // ── 11. Build Claude messages array ───────────────────────────────────
    const systemPrompt = this.buildSystemPrompt(session, campaignPatient);
    const claudeMessages = this.buildClaudeMessages(session);

    // ── 12. Call Claude ────────────────────────────────────────────────────
    const response = await this.callClaude(systemPrompt, claudeMessages, aiMaxTurns);

    // ── 13. Execute tool calls ────────────────────────────────────────────
    // Tool calls are side effects — complaints, bookings, handoffs, end_conversation.
    // We collect Claude's text response separately.
    const { textReply, conversationEnded } = await this.processClaudeResponse(
      response,
      session,
      campaignPatient.id,
      campaignPatient.campaignId,
      clinic.notificationPhone ?? campaign_notification_phone_fallback(campaignPatient),
      patientMessage,
    );

    // ── 14. Send text reply to patient ────────────────────────────────────
    if (textReply) {
      await this.whatsappService.sendText(phone, textReply);

      const assistantMessage: CampaignMessage = {
        role:      'assistant',
        content:   textReply,
        timestamp: Date.now(),
      };
      session.messages.push(assistantMessage);
    }

    // ── 15. Increment turn count ───────────────────────────────────────────
    session.turnCount += 1;

    // ── 16. Persist messages to DB ────────────────────────────────────────
    await this.prisma.campaignPatient.update({
      where: { id: campaignPatient.id },
      data: {
        messages:  session.messages as any,
        turnCount: session.turnCount,
      },
    });

    // ── 17. Save updated session to Redis (unless conversation ended) ─────
    if (!conversationEnded) {
      await this.sessionsService.saveCampaignSession(session);
    }

    this.logger.log(
      `Turn ${session.turnCount}/${aiMaxTurns} complete for ${phone}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SYSTEM PROMPT BUILDER
  // ═══════════════════════════════════════════════════════════════════════════

  private buildSystemPrompt(
    session:         CampaignSession,
    campaignPatient: { patientSnapshot: any; patientName: string; visitDate: Date; prestation: string; medecinTraitant: string; ageYears: number | null; sexe: string | null; ville: string | null },
  ): string {
    const snapshot      = campaignPatient.patientSnapshot as Record<string, any>;
    const patientData   = snapshot?.patient  ?? {};
    const historyData   = snapshot?.history  ?? null;
    const language      = session.language ?? Language.FR;

    const languageInstruction = language === Language.EN
      ? 'Always respond in English.'
      : language === Language.AR
        ? 'Respond in Moroccan Darija (Arabic). Use simple, clear language.'
        : 'Always respond in French. Use polite, professional "vous" form.';

    // Build admission history summary
    let historySection = 'No previous admission history available.';
    if (historyData?.admissions && Array.isArray(historyData.admissions) && historyData.admissions.length > 0) {
      const admissions = historyData.admissions
        .slice(0, 10) // last 10 admissions max — avoid bloating context
        .map((a: any, i: number) => {
          const date   = a.date_admission ? new Date(a.date_admission).toLocaleDateString('fr-FR') : 'Unknown date';
          const motif  = a.motif_admission ?? 'Unknown';
          const doctor = a.medecin_traitant ?? 'Unknown';
          const actes  = Array.isArray(a.actes_realises) && a.actes_realises.length > 0
            ? a.actes_realises.join(', ')
            : 'None recorded';
          return `  ${i + 1}. ${date} — ${motif} (Dr. ${doctor}) | Actes: ${actes}`;
        })
        .join('\n');

      const solde = historyData.solde_impaye ?? 0;
      historySection = `Previous admissions (most recent first):\n${admissions}\nOutstanding balance: ${solde} MAD`;
    }

    const visitDate = new Date(campaignPatient.visitDate).toLocaleDateString('fr-FR');

    return `You are a compassionate, professional medical follow-up assistant for Innova Smart Health clinic in Casablanca, Morocco.

${languageInstruction}

PATIENT CONTEXT:
- Name: ${campaignPatient.patientName}
- Age: ${campaignPatient.ageYears ?? 'Unknown'} years old
- Sex: ${campaignPatient.sexe ?? 'Unknown'}
- City: ${campaignPatient.ville ?? 'Unknown'}
- Last visit: ${visitDate}
- Reason for last visit: ${campaignPatient.prestation}
- Treating doctor: ${campaignPatient.medecinTraitant}

PATIENT HISTORY:
${historySection}

YOUR ROLE:
- Follow up on the patient's wellbeing after their recent visit
- Listen carefully to any concerns they express
- If they have complaints or medical concerns, use the log_complaint tool
- If they want to book a new appointment, use the request_booking tool
- If the situation is urgent or complex, use the request_handoff tool
- When the conversation reaches a natural conclusion, use the end_conversation tool
- Be warm, empathetic, and concise — this is WhatsApp, not email
- Never invent medical advice or diagnoses
- Never share other patients' information
- If the patient asks to stop receiving messages, respect their request and use end_conversation with outcome OPTED_OUT

CONVERSATION RULES:
- Keep messages short (2-4 sentences max for WhatsApp)
- Never ask more than one question at a time
- If the patient seems distressed, escalate immediately via request_handoff
- Current turn: ${session.turnCount + 1}`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUILD CLAUDE MESSAGES ARRAY
  // ═══════════════════════════════════════════════════════════════════════════

  private buildClaudeMessages(
    session: CampaignSession,
  ): { role: 'user' | 'assistant'; content: string }[] {
    // Map session messages to Claude format
    // Only include messages that have content — filter out empty strings
    return session.messages
      .filter(m => m.content?.trim())
      .map(m => ({
        role:    m.role,
        content: m.content,
      }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CALL CLAUDE API
  // ═══════════════════════════════════════════════════════════════════════════

  private async callClaude(
    systemPrompt: string,
    messages:     { role: 'user' | 'assistant'; content: string }[],
    aiMaxTurns:   number,
  ): Promise<AnthropicMessage> {
    // max_tokens scaled to conversation length — short WhatsApp replies need little
    const maxTokens = Math.min(1024, Math.max(256, aiMaxTurns * 20));

    const body = {
      model:      ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system:     systemPrompt,
      tools:      CLAUDE_TOOLS,
      messages,
    };

    const response = await fetch(ANTHROPIC_API_URL, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         this.anthropicApiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      let errorBody = '';
      try {
        errorBody = JSON.stringify(await response.json());
      } catch {
        errorBody = await response.text().catch(() => '');
      }
      const msg = `Anthropic API error ${response.status}: ${errorBody}`;
      this.logger.error(msg);
      throw new Error(msg);
    }

    return response.json() as Promise<AnthropicMessage>;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROCESS CLAUDE RESPONSE — execute tools, extract text
  // ═══════════════════════════════════════════════════════════════════════════

  private async processClaudeResponse(
    response:            AnthropicMessage,
    session:             CampaignSession,
    campaignPatientId:   string,
    campaignId:          string,
    notificationPhone:   string | null,
    rawPatientMessage:   string,
  ): Promise<{ textReply: string | null; conversationEnded: boolean }> {
    let textReply:         string | null = null;
    let conversationEnded: boolean       = false;

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        // Concatenate all text blocks into one reply
        textReply = textReply
          ? `${textReply}\n\n${block.text.trim()}`
          : block.text.trim();
        continue;
      }

      if (block.type === 'tool_use') {
        this.logger.log(`Tool called: ${block.name} — input: ${JSON.stringify(block.input)}`);

        switch (block.name) {
          case 'log_complaint': {
            const input = block.input as unknown as LogComplaintInput;
            await this.executeLogComplaint(input, campaignPatientId, session.clinicId, rawPatientMessage, campaignId);
            break;
          }

          case 'request_booking': {
            const input = block.input as unknown as RequestBookingInput;
            await this.executeRequestBooking(input, campaignPatientId, session.clinicId, rawPatientMessage);
            break;
          }

          case 'request_handoff': {
            const input = block.input as unknown as RequestHandoffInput;
            await this.executeRequestHandoff(input, session, campaignPatientId, campaignId, notificationPhone);
            conversationEnded = true;
            break;
          }

          case 'end_conversation': {
            const input = block.input as unknown as EndConversationInput;
            await this.closeConversation(session, campaignPatientId, campaignId, input.outcome);
            conversationEnded = true;
            break;
          }

          default:
            this.logger.warn(`Unknown tool called: ${block.name}`);
        }
      }
    }

    // If Claude returned tool_use as stop_reason but no text, that's fine —
    // tool was a side effect only. If there's no text reply and conversation
    // didn't end, Claude just processed the turn silently.
    return { textReply, conversationEnded };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL EXECUTORS
  // ═══════════════════════════════════════════════════════════════════════════

  private async executeLogComplaint(
    input:             LogComplaintInput,
    campaignPatientId: string,
    clinicId:          string,
    triggeringMessage: string,
    campaignId:        string,
  ): Promise<void> {
    await this.prisma.complaint.create({
      data: {
        campaignPatientId,
        clinicId,
        type:             input.type,
        severity:         input.severity,
        triggeringMessage,
        summary:          input.summary,
      },
    });

    // Increment campaign complainedCount
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data:  { complainedCount: { increment: 1 } },
    });

    this.logger.log(
      `Complaint logged: ${input.type} / ${input.severity} for patient ${campaignPatientId}`,
    );
  }

  private async executeRequestBooking(
    input:             RequestBookingInput,
    campaignPatientId: string,
    clinicId:          string,
    rawPatientMessage: string,
  ): Promise<void> {
    await this.prisma.bookingRequest.create({
      data: {
        campaignPatientId,
        clinicId,
        preferredDoctor:    input.preferredDoctor    ?? null,
        preferredDateRange: input.preferredDateRange ?? null,
        reason:             input.reason             ?? null,
        rawPatientRequest:  rawPatientMessage,
      },
    });

    this.logger.log(`Booking request created for patient ${campaignPatientId}`);
  }

  private async executeRequestHandoff(
    input:             RequestHandoffInput,
    session:           CampaignSession,
    campaignPatientId: string,
    campaignId:        string,
    notificationPhone: string | null,
  ): Promise<void> {
    // Update session status
    session.status = 'handed_off';

    // Update patient record
    await this.prisma.campaignPatient.update({
      where: { id: campaignPatientId },
      data: {
        status:      CampaignPatientStatus.COMPLETED,
        outcome:     ConversationOutcome.HANDED_OFF,
        completedAt: new Date(),
      },
    });

    // Increment campaign completedCount
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data:  { completedCount: { increment: 1 } },
    });

    // Delete Redis session — conversation is over
    await this.sessionsService.deleteCampaignSession(session.phone);

    // Notify staff via WhatsApp if a notification phone is configured
    if (notificationPhone) {
      try {
        const msg =
          `🔴 Handoff Required\n` +
          `Patient: ${session.phone}\n` +
          `Reason: ${input.reason}`;
        await this.whatsappService.sendText(notificationPhone, msg);
      } catch (err: any) {
        // Staff notification failure must not crash the patient flow
        this.logger.error(`Failed to notify staff of handoff: ${err.message}`);
      }
    }

    this.logger.log(
      `Handoff executed for patient ${campaignPatientId} — reason: ${input.reason}`,
    );
  }

  private async closeConversation(
    session:           CampaignSession,
    campaignPatientId: string,
    campaignId:        string,
    outcome:           ConversationOutcome,
  ): Promise<void> {
    session.status = 'completed';

    await this.prisma.campaignPatient.update({
      where: { id: campaignPatientId },
      data: {
        status:      CampaignPatientStatus.COMPLETED,
        outcome,
        completedAt: new Date(),
      },
    });

    // Increment campaign completedCount
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data:  { completedCount: { increment: 1 } },
    });

    // Delete Redis session — conversation is over
    await this.sessionsService.deleteCampaignSession(session.phone);

    this.logger.log(
      `Conversation closed for patient ${campaignPatientId} — outcome: ${outcome}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Detects language from the first patient message.
   * Simple heuristic — Arabic script detection + common French/English words.
   * Good enough for first-message detection; Claude adapts from context after.
   */
  private detectLanguage(message: string): Language {
    // Arabic script detection — covers Darija written in Arabic
    if (/[\u0600-\u06FF]/.test(message)) return Language.AR;

    const lower = message.toLowerCase();

    // Common French indicators
    const frenchWords = ['bonjour', 'merci', 'oui', 'non', 'je', 'vous', 'comment', 'bien', 'bonsoir', 'salam'];
    if (frenchWords.some(w => lower.includes(w))) return Language.FR;

    // Common English indicators
    const englishWords = ['hello', 'hi', 'thanks', 'yes', 'no', 'good', 'how', 'please', 'fine'];
    if (englishWords.some(w => lower.includes(w))) return Language.EN;

    // Default to clinic default — FR for Innova
    return Language.FR;
  }

  /**
   * Resolves aiMaxTurns — campaign override takes precedence over clinic default.
   */
  private async resolveAiMaxTurns(campaignId: string, clinicAiMaxTurns: number): Promise<number> {
    const campaign = await this.prisma.campaign.findUnique({
      where:  { id: campaignId },
      select: { aiMaxTurns: true },
    });
    return campaign?.aiMaxTurns ?? clinicAiMaxTurns;
  }

  /**
   * Fetches a single bot message body from the DB.
   * Falls back to FR if the requested language has no record.
   */
  async fetchBotMessage(
    clinicId: string,
    key:      MessageKey,
    language: Language,
  ): Promise<string | null> {
    const record = await this.prisma.botMessage.findUnique({
      where: { clinicId_key_language: { clinicId, key, language } },
    });
    if (record) return record.body;

    if (language !== Language.FR) {
      const fallback = await this.prisma.botMessage.findUnique({
        where: { clinicId_key_language: { clinicId, key, language: Language.FR } },
      });
      if (fallback) return fallback.body;
    }

    return null;
  }
}

// ─── Module-level helper (not a method — avoids extra DB call) ────────────────
// Resolves notification phone from campaign patient's campaign when clinic has none.
// This is called only in the handoff path where we already have campaignPatient loaded.
function campaign_notification_phone_fallback(
  campaignPatient: { campaignId: string },
): null {
  // No fallback possible without an extra DB call here — caller handles null gracefully.
  return null;
}