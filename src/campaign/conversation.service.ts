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

interface AnthropicToolResultBlock {
  type:       'tool_result';
  tool_use_id: string;
  content:    string;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

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

// Retry config for transient failures
const MAX_RETRIES = 2;
const RETRY_DELAY = 1500;

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);
  private readonly anthropicApiKey: string | undefined;
  private readonly isEnabled: boolean;

  constructor(
    private readonly configService:  ConfigService,
    private readonly prisma:         PrismaService,
    private readonly sessionsService: SessionsService,
    private readonly whatsappService: WhatsAppService,
  ) {
    const key = this.configService.get<string>('anthropic.apiKey');
    if (!key) {
      this.logger.warn('ANTHROPIC_API_KEY not set — AI follow-up will use basic responses only');
      this.anthropicApiKey = undefined;
      this.isEnabled = false;
    } else {
      this.anthropicApiKey = key;
      this.isEnabled = true;
    }
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

    // ── 2. Guard: session already closed or being handled by staff ────────
    if (session.status === 'completed' || session.status === 'handed_off' || session.status === 'admin_handling') {
      this.logger.warn(
        `Campaign session for ${phone} is ${session.status} — ignoring reply`,
      );
      return;
    }

    // ── 3. Load CampaignPatient from DB ────────────────────────────────────
    const campaignPatient = await this.prisma.campaignPatient.findUnique({
      where: { id: session.campaignPatientId },
      include: { campaign: true },
    });

    if (!campaignPatient) {
      this.logger.error(
        `CampaignPatient ${session.campaignPatientId} not found for phone ${phone}`,
      );
      return;
    }

    // ── 4. Load clinic ────────────────────────────────────────────────────
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: session.clinicId },
    });

    if (!clinic) {
      this.logger.error(`Clinic ${session.clinicId} not found`);
      return;
    }

    // ── 5. Detect and persist language on first reply (and re-detect if AI enabled) ──
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

      await this.prisma.campaign.update({
        where: { id: campaignPatient.campaignId },
        data:  { repliedCount: { increment: 1 } },
      });
    }

    // ── 7. Duplicate guard — don't re-append if message already present ───
    const alreadyPresent = session.messages.some(
      m => m.role === 'user' && m.content === patientMessage && Date.now() - m.timestamp < 5000,
    );
    if (!alreadyPresent) {
      const userMessage: CampaignMessage = {
        role:      'user',
        content:   patientMessage,
        timestamp: Date.now(),
      };
      session.messages.push(userMessage);
    }

    // ── 8. Resolve aiMaxTurns (cached in session after first lookup) ──────
    let aiMaxTurns = (session as any).cachedAiMaxTurns as number | undefined;
    if (!aiMaxTurns) {
      aiMaxTurns = clinic.aiMaxTurns;
      const campaign = campaignPatient.campaign;
      if (campaign && campaign.aiMaxTurns !== null && campaign.aiMaxTurns !== undefined) {
        aiMaxTurns = campaign.aiMaxTurns;
      }
      (session as any).cachedAiMaxTurns = aiMaxTurns;
    }

    // ── 9. Auto-close if turn limit reached — send farewell first ─────────
    if (session.turnCount >= aiMaxTurns) {
      this.logger.warn(
        `Turn limit (${aiMaxTurns}) reached for ${phone} — sending farewell and closing`,
      );

      const farewell = await this.fetchBotMessage(
        clinic.id,
        MessageKey.CAMPAIGN_URGENT_MESSAGE,
        session.language ?? Language.FR,
      ).catch(() => null);

      if (farewell) {
        await this.whatsappService.sendText(phone, farewell);
      }

      await this.closeConversation(session, campaignPatient.id, campaignPatient.campaignId, ConversationOutcome.COMPLETED);
      return;
    }

    // ── 10. Send typing indicator ──────────────────────────────────────────
    await this.whatsappService.sendText(phone, '⏳');

    // ── 11. Build Claude messages array (include tool_use blocks) ──────────
    const systemPrompt = this.buildSystemPrompt(session, campaignPatient, clinic);
    const claudeMessages = this.buildClaudeMessages(session);

    // ── 12. Call Claude (with retry) ──────────────────────────────────────
    let response: AnthropicMessage;
    try {
      response = await this.callClaudeWithRetry(systemPrompt, claudeMessages);
    } catch (err: any) {
      this.logger.error(`Claude call failed after retries for ${phone}: ${err.message}`);
      await this.whatsappService.sendText(phone, '⚠️ Désolé, je rencontre un problème technique. Veuillez réessayer dans quelques minutes.');
      return;
    }

    // ── 13. Delete typing indicator by sending real reply (noop if same) ──
    // The real reply will follow immediately.

    // ── 14. Execute tool calls FIRST, collect text AFTER ──────────────────
    const { textReply, conversationEnded } = await this.processClaudeResponse(
      response,
      session,
      campaignPatient.id,
      campaignPatient.campaignId,
      clinic,
      patientMessage,
    );

    // ── 15. Send text reply to patient ────────────────────────────────────
    if (textReply) {
      await this.whatsappService.sendText(phone, textReply);

      const assistantMessage: CampaignMessage = {
        role:      'assistant',
        content:   textReply,
        timestamp: Date.now(),
      };
      session.messages.push(assistantMessage);
    }

    // ── 16. Increment turn count ───────────────────────────────────────────
    session.turnCount += 1;

    // ── 17. Log token usage ────────────────────────────────────────────────
    if (response.usage) {
      try {
        await this.prisma.aiUsage.create({
          data: {
            campaignPatientId: campaignPatient.id,
            clinicId:          clinic.id,
            campaignId:        campaignPatient.campaignId,
            inputTokens:       response.usage.input_tokens,
            outputTokens:      response.usage.output_tokens,
            model:             ANTHROPIC_MODEL,
          },
        });
      } catch (e: any) {
        this.logger.warn(`Failed to log token usage: ${e.message}`);
      }
    }

    // ── 18. Persist messages to DB ────────────────────────────────────────
    await this.prisma.campaignPatient.update({
      where: { id: campaignPatient.id },
      data: {
        messages:  session.messages as any,
        turnCount: session.turnCount,
      },
    });

    // ── 19. Save updated session to Redis (unless conversation ended) ─────
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
    clinic:          { name: string; phone: string; address?: string | null; openingHours?: string | null },
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
        .slice(0, 10)
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

    // Build clinic info — include whatever is available
    const clinicInfoParts: string[] = [];
    if (clinic.phone) clinicInfoParts.push(`Clinic phone: ${clinic.phone}`);
    if (clinic.address) clinicInfoParts.push(`Clinic address: ${clinic.address}`);
    if (clinic.openingHours) clinicInfoParts.push(`Clinic hours: ${clinic.openingHours}`);
    const clinicInfoSection = clinicInfoParts.length > 0
      ? `CLINIC INFO:\n${clinicInfoParts.join('\n')}\n`
      : '';

    return `You are a compassionate, professional medical follow-up assistant for ${clinic.name}.

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

${clinicInfoSection}
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
- For rebooking, direct them to call ${clinic.phone || 'the clinic'} or visit ${clinic.address || 'the clinic'}

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
    // Map session messages to Claude format.
    // Include all non-empty messages; tool_use blocks are preserved as assistant content.
    return session.messages
      .filter(m => m.content?.trim())
      .map(m => ({
        role:    m.role,
        content: m.content,
      }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CALL CLAUDE API (with retry)
  // ═══════════════════════════════════════════════════════════════════════════

  private async callClaude(
    systemPrompt: string,
    messages:     { role: 'user' | 'assistant'; content: string }[],
  ): Promise<AnthropicMessage> {
    const maxTokens = 1024; // Fixed large enough for reply + tool call JSON

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
        'x-api-key':         this.anthropicApiKey!,
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

  private async callClaudeWithRetry(
    systemPrompt: string,
    messages:     { role: 'user' | 'assistant'; content: string }[],
  ): Promise<AnthropicMessage> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.callClaude(systemPrompt, messages);
      } catch (err: any) {
        lastError = err;
        const status = err.message.match(/status (\d+)/)?.[1];
        // Only retry on transient errors
        if (status && (status === '529' || status.startsWith('5'))) {
          this.logger.warn(`Anthropic API ${status} — retrying (${attempt + 1}/${MAX_RETRIES})`);
          if (attempt < MAX_RETRIES) {
            await new Delay(RETRY_DELAY * (attempt + 1));
            continue;
          }
        }
        throw err;
      }
    }
    throw lastError;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROCESS CLAUDE RESPONSE — execute tools FIRST, extract text AFTER
  // ═══════════════════════════════════════════════════════════════════════════

  private async processClaudeResponse(
    response:            AnthropicMessage,
    session:             CampaignSession,
    campaignPatientId:   string,
    campaignId:          string,
    clinic:              { id: string; name: string; phone: string; notificationPhone?: string | null },
    rawPatientMessage:   string,
  ): Promise<{ textReply: string | null; conversationEnded: boolean }> {
    let textReply:         string | null = null;
    let conversationEnded: boolean       = false;

    // First pass: collect all tool_use blocks and all text blocks
    const toolBlocks: AnthropicToolUseBlock[] = [];
    const textBlocks: AnthropicTextBlock[] = [];

    for (const block of response.content) {
      if (block.type === 'text' && (block as AnthropicTextBlock).text.trim()) {
        textBlocks.push(block as AnthropicTextBlock);
      } else if (block.type === 'tool_use') {
        toolBlocks.push(block as AnthropicToolUseBlock);
      }
    }

    // Execute ALL tool calls first — side effects happen before any text is shown
    for (const toolBlock of toolBlocks) {
      this.logger.log(`Tool called: ${toolBlock.name} — input: ${JSON.stringify(toolBlock.input)}`);

      try {
        switch (toolBlock.name) {
          case 'log_complaint': {
            const input = toolBlock.input as unknown as LogComplaintInput;
            await this.executeLogComplaint(input, campaignPatientId, clinic.id, rawPatientMessage, campaignId, clinic);
            break;
          }
          case 'request_booking': {
            const input = toolBlock.input as unknown as RequestBookingInput;
            await this.executeRequestBooking(input, campaignPatientId, clinic.id, rawPatientMessage);
            break;
          }
          case 'request_handoff': {
            const input = toolBlock.input as unknown as RequestHandoffInput;
            await this.executeRequestHandoff(input, session, campaignPatientId, campaignId, clinic);
            conversationEnded = true;
            break;
          }
          case 'end_conversation': {
            const input = toolBlock.input as unknown as EndConversationInput;
            await this.closeConversation(session, campaignPatientId, campaignId, input.outcome);
            conversationEnded = true;
            break;
          }
          default:
            this.logger.warn(`Unknown tool called: ${toolBlock.name}`);
        }
      } catch (err: any) {
        this.logger.error(`Tool ${toolBlock.name} execution failed: ${err.message}`);
      }
    }

    // Now concatenate all text blocks into the reply (after tools are done)
    for (const block of textBlocks) {
      const trimmed = block.text.trim();
      if (!trimmed) continue;
      textReply = textReply ? `${textReply}\n\n${trimmed}` : trimmed;
    }

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
    clinic:            { id: string; notificationPhone?: string | null },
  ): Promise<void> {
    const complaint = await this.prisma.complaint.create({
      data: {
        campaignPatientId,
        clinicId,
        type:             input.type,
        severity:         input.severity,
        triggeringMessage,
        summary:          input.summary,
      },
    });

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data:  { complainedCount: { increment: 1 } },
    });

    this.logger.log(
      `Complaint logged: ${input.type} / ${input.severity} for patient ${campaignPatientId}`,
    );

    // HIGH severity → immediate staff alert
    if (input.severity === ComplaintSeverity.HIGH && clinic.notificationPhone) {
      try {
        await this.whatsappService.sendText(
          clinic.notificationPhone,
          `🔴 HIGH SEVERITY COMPLAINT\nPatient: ${campaignPatientId}\nType: ${input.type}\nSummary: ${input.summary}\n\nPlease review immediately.`,
        );
      } catch (err: any) {
        this.logger.error(`Failed to send HIGH complaint alert to staff: ${err.message}`);
      }
    }
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
    clinic:            { id: string; notificationPhone?: string | null },
  ): Promise<void> {
    // Update session status FIRST so any concurrent callers see admin_handling
    session.status = 'handed_off';

    await this.prisma.campaignPatient.update({
      where: { id: campaignPatientId },
      data: {
        status:      CampaignPatientStatus.COMPLETED,
        outcome:     ConversationOutcome.HANDED_OFF,
        completedAt: new Date(),
      },
    });

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data:  { completedCount: { increment: 1 } },
    });

    // Send handoff acknowledgement to patient BEFORE deleting session
    const handoffMsg = await this.fetchBotMessage(clinic.id, MessageKey.CAMPAIGN_HANDOFF_MESSAGE, session.language ?? Language.FR)
      .catch(() => 'Un agent va vous contacter sous peu.');
    if (handoffMsg) {
      try {
        await this.whatsappService.sendText(session.phone, handoffMsg);
      } catch (err: any) {
        this.logger.error(`Failed to send handoff message to patient: ${err.message}`);
      }
    }

    // Now delete Redis session — conversation is over
    await this.sessionsService.deleteCampaignSession(session.phone);

    // Notify staff via WhatsApp if a notification phone is configured
    if (clinic.notificationPhone) {
      try {
        const msg =
          `🔴 Handoff Required\n` +
          `Patient: ${session.phone}\n` +
          `Reason: ${input.reason}`;
        await this.whatsappService.sendText(clinic.notificationPhone, msg);
      } catch (err: any) {
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

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data:  { completedCount: { increment: 1 } },
    });

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
   */
  private detectLanguage(message: string): Language {
    // Arabic script detection — covers Darija written in Arabic
    if (/[\u0600-\u06FF]/.test(message)) return Language.AR;

    const lower = message.toLowerCase();

    const frenchWords = ['bonjour', 'merci', 'oui', 'non', 'je', 'vous', 'comment', 'bien', 'bonsoir', 'salam'];
    if (frenchWords.some(w => lower.includes(w))) return Language.FR;

    const englishWords = ['hello', 'hi', 'thanks', 'yes', 'no', 'good', 'how', 'please', 'fine'];
    if (englishWords.some(w => lower.includes(w))) return Language.EN;

    return Language.FR;
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

// ─── Delay helper for retry ────────────────────────────────────────────────────
class Delay extends Promise<void> {
  constructor(ms: number) {
    super(resolve => setTimeout(resolve, ms));
  }
}