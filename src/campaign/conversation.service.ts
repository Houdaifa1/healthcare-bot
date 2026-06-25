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

// ─── OpenAI-compatible response types (OpenRouter uses this format) ───────────

interface OAIToolCall {
  id:       string;
  type:     'function';
  function: {
    name:      string;
    arguments: string; // JSON string
  };
}

interface OAIMessage {
  role:        'assistant';
  content:     string | null;
  tool_calls?: OAIToolCall[];
}

interface OAIChoice {
  message:       OAIMessage;
  finish_reason: 'stop' | 'tool_calls' | 'length' | string;
}

interface OAIResponse {
  choices: OAIChoice[];
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

// ─── Tool definitions (OpenAI function-calling format) ────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name:        'log_complaint',
      description: 'Log a patient complaint or medical concern detected in the conversation. Call this whenever the patient expresses dissatisfaction, reports a medical issue, or describes an urgent situation.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type:        'string',
            enum:        ['COMPLAINT', 'MEDICAL_CONCERN', 'URGENT'],
            description: 'COMPLAINT = service/experience complaint, MEDICAL_CONCERN = health issue, URGENT = emergency requiring immediate attention',
          },
          severity: {
            type:        'string',
            enum:        ['LOW', 'MEDIUM', 'HIGH'],
            description: 'LOW = minor inconvenience, MEDIUM = significant issue, HIGH = serious concern requiring urgent staff attention',
          },
          summary: {
            type:        'string',
            description: 'A clear 1-2 sentence summary of the complaint in the language the patient used',
          },
        },
        required: ['type', 'severity', 'summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'request_booking',
      description: 'Create a booking request when the patient expresses intent to schedule a new appointment or follow-up visit.',
      parameters: {
        type: 'object',
        properties: {
          preferredDoctor: {
            type:        'string',
            description: 'Doctor name if the patient mentioned a preference',
          },
          preferredDateRange: {
            type:        'string',
            description: 'Free text date preference as expressed by the patient, e.g. "semaine prochaine", "lundi matin", "next week"',
          },
          reason: {
            type:        'string',
            description: 'Reason for the new appointment as expressed by the patient',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'request_handoff',
      description: 'Transfer the conversation to a human staff member. Use when the patient is very distressed, the situation is too complex for AI, the patient explicitly asks for a human, or there is an urgent medical situation.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type:        'string',
            description: 'Clear explanation of why handoff is needed, for the staff member who will take over',
          },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'end_conversation',
      description: 'Close the conversation when the follow-up is complete. Call this when the patient has no more concerns, has been helped, or has clearly disengaged.',
      parameters: {
        type: 'object',
        properties: {
          outcome: {
            type:        'string',
            enum:        ['COMPLETED', 'COMPLAINED', 'REBOOKED', 'HANDED_OFF', 'URGENT', 'OPTED_OUT', 'NO_RESPONSE'],
            description: 'The final outcome of this conversation',
          },
        },
        required: ['outcome'],
      },
    },
  },
];

// ─── Model config ─────────────────────────────────────────────────────────────

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'qwen/qwen3-next-80b-a3b-instruct:free';

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);
  private readonly apiKey: string;

  constructor(
    private readonly configService:   ConfigService,
    private readonly prisma:          PrismaService,
    private readonly sessionsService: SessionsService,
    private readonly whatsappService: WhatsAppService,
  ) {
    const key = this.configService.get<string>('openrouter.apiKey');
    if (!key) {
      throw new Error('OPENROUTER_API_KEY is not set');
    }
    this.apiKey = key;
    this.logger.log(`ConversationService initialized — model: ${OPENROUTER_MODEL}`);
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

    // ── 4. Load clinic for aiMaxTurns and notification settings ────────────
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: session.clinicId },
    });

    if (!clinic) {
      this.logger.error(`Clinic ${session.clinicId} not found`);
      return;
    }

    // ── 5. Detect and persist language on first reply ─────────────────────
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

    // ── 7. Update session status to active ────────────────────────────────
    session.status = 'active';

    // ── 8. Append patient message to session ──────────────────────────────
    const userMessage: CampaignMessage = {
      role:      'user',
      content:   patientMessage,
      timestamp: Date.now(),
    };
    session.messages.push(userMessage);

    // ── 9. Resolve aiMaxTurns — campaign override takes precedence ─────────
    const aiMaxTurns = await this.resolveAiMaxTurns(campaignPatient.campaignId, clinic.aiMaxTurns);

    // ── 10. Auto-close if turn limit reached ──────────────────────────────
    if (session.turnCount >= aiMaxTurns) {
      this.logger.warn(
        `Turn limit (${aiMaxTurns}) reached for ${phone} — auto-closing conversation`,
      );
      await this.closeConversation(
        session,
        campaignPatient.id,
        campaignPatient.campaignId,
        ConversationOutcome.COMPLETED,
      );
      return;
    }

    // ── 11. Build prompt and messages ──────────────────────────────────────
    const systemPrompt  = this.buildSystemPrompt(session, campaignPatient);
    const messages      = this.buildMessages(session);

    // ── 12. Call DeepSeek via OpenRouter ──────────────────────────────────
    const response = await this.callModel(systemPrompt, messages, aiMaxTurns);

    // ── 13. Process response — execute tools, extract text reply ──────────
    const { textReply, conversationEnded } = await this.processResponse(
      response,
      session,
      campaignPatient.id,
      campaignPatient.campaignId,
      clinic.notificationPhone ?? null,
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

    // ── 16. Persist messages and turn count to DB ─────────────────────────
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

    this.logger.log(`Turn ${session.turnCount}/${aiMaxTurns} complete for ${phone}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SYSTEM PROMPT BUILDER
  // ═══════════════════════════════════════════════════════════════════════════

  private buildSystemPrompt(
    session:         CampaignSession,
    campaignPatient: {
      patientSnapshot: any;
      patientName:     string;
      visitDate:       Date;
      prestation:      string;
      medecinTraitant: string;
      ageYears:        number | null;
      sexe:            string | null;
      ville:           string | null;
    },
  ): string {
    const snapshot    = campaignPatient.patientSnapshot as Record<string, any>;
    const historyData = snapshot?.history ?? null;
    const language    = session.language ?? Language.FR;

    const languageInstruction =
      language === Language.EN ? 'Always respond in English.' :
      language === Language.AR ? 'Respond in Moroccan Darija (Arabic). Use simple, clear language.' :
      'Always respond in French. Use polite, professional "vous" form.';

    let historySection = 'No previous admission history available.';
    if (historyData?.admissions && Array.isArray(historyData.admissions) && historyData.admissions.length > 0) {
      const lines = historyData.admissions
        .slice(0, 10)
        .map((a: any, i: number) => {
          const date   = a.date_admission ? new Date(a.date_admission).toLocaleDateString('fr-FR') : 'Unknown date';
          const motif  = a.motif_admission  ?? 'Unknown';
          const doctor = a.medecin_traitant ?? 'Unknown';
          const actes  = Array.isArray(a.actes_realises) && a.actes_realises.length > 0
            ? a.actes_realises.join(', ')
            : 'None recorded';
          return `  ${i + 1}. ${date} — ${motif} (Dr. ${doctor}) | Actes: ${actes}`;
        })
        .join('\n');

      const solde = historyData.solde_impaye ?? 0;
      historySection = `Previous admissions (most recent first):\n${lines}\nOutstanding balance: ${solde} MAD`;
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
  // BUILD MESSAGES ARRAY
  // ═══════════════════════════════════════════════════════════════════════════

  private buildMessages(
    session: CampaignSession,
  ): { role: 'user' | 'assistant'; content: string }[] {
    return session.messages
      .filter(m => m.content?.trim())
      .map(m => ({ role: m.role, content: m.content }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CALL MODEL — OpenRouter + DeepSeek via OpenAI-compatible REST API
  // ═══════════════════════════════════════════════════════════════════════════

  private async callModel(
    systemPrompt: string,
    messages:     { role: 'user' | 'assistant'; content: string }[],
    aiMaxTurns:   number,
  ): Promise<OAIResponse> {
    // Always allow enough tokens for tool call JSON + text reply
    const maxTokens = Math.max(1024, aiMaxTurns * 20);

    const body = {
      model:       OPENROUTER_MODEL,
      max_tokens:  maxTokens,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      tools:       TOOLS,
      tool_choice: 'auto',
    };

    const response = await fetch(OPENROUTER_API_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer':  'https://innova-smart-health.ma',
        'X-Title':       'Innova Smart Health Bot',
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
      const msg = `OpenRouter API error ${response.status}: ${errorBody}`;
      this.logger.error(msg);
      throw new Error(msg);
    }

    const result = await response.json() as OAIResponse;
    this.logger.debug(
      `Model response: finish_reason=${result.choices[0]?.finish_reason} ` +
      `tool_calls=${result.choices[0]?.message.tool_calls?.length ?? 0}`,
    );
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROCESS RESPONSE — execute structured tool calls, extract text reply
  // No regex, no text parsing — DeepSeek returns proper structured tool calls
  // ═══════════════════════════════════════════════════════════════════════════

  private async processResponse(
    response:          OAIResponse,
    session:           CampaignSession,
    campaignPatientId: string,
    campaignId:        string,
    notificationPhone: string | null,
    rawPatientMessage: string,
  ): Promise<{ textReply: string | null; conversationEnded: boolean }> {
    let textReply:         string | null = null;
    let conversationEnded: boolean       = false;

    const choice = response.choices[0];
    if (!choice) {
      this.logger.warn('Model returned no choices');
      return { textReply: null, conversationEnded: false };
    }

    const msg = choice.message;

    // ── Extract text content ───────────────────────────────────────────────
    if (msg.content?.trim()) {
      textReply = msg.content.trim();
    }

    // ── Execute structured tool calls ──────────────────────────────────────
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const toolCall of msg.tool_calls) {
        const name = toolCall.function.name;

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          this.logger.warn(
            `Failed to parse tool arguments for "${name}": ${toolCall.function.arguments}`,
          );
          continue;
        }

        this.logger.log(`Tool called: ${name} — ${JSON.stringify(args)}`);

        const result = await this.executeToolCall(
          name,
          args,
          session,
          campaignPatientId,
          campaignId,
          notificationPhone,
          rawPatientMessage,
        );

        if (result.ended) conversationEnded = true;
      }
    }

    return { textReply, conversationEnded };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL CALL EXECUTOR
  // ═══════════════════════════════════════════════════════════════════════════

  private async executeToolCall(
    name:              string,
    args:              Record<string, unknown>,
    session:           CampaignSession,
    campaignPatientId: string,
    campaignId:        string,
    notificationPhone: string | null,
    rawPatientMessage: string,
  ): Promise<{ ended: boolean }> {
    switch (name) {
      case 'log_complaint': {
        await this.executeLogComplaint(
          args as unknown as LogComplaintInput,
          campaignPatientId,
          session.clinicId,
          rawPatientMessage,
          campaignId,
        );
        return { ended: false };
      }
      case 'request_booking': {
        await this.executeRequestBooking(
          args as unknown as RequestBookingInput,
          campaignPatientId,
          session.clinicId,
          rawPatientMessage,
        );
        return { ended: false };
      }
      case 'request_handoff': {
        await this.executeRequestHandoff(
          args as unknown as RequestHandoffInput,
          session,
          campaignPatientId,
          campaignId,
          notificationPhone,
        );
        return { ended: true };
      }
      case 'end_conversation': {
        await this.closeConversation(
          session,
          campaignPatientId,
          campaignId,
          (args as unknown as EndConversationInput).outcome,
        );
        return { ended: true };
      }
      default:
        this.logger.warn(`Unknown tool called: ${name}`);
        return { ended: false };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL IMPLEMENTATIONS
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

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data:  { complainedCount: { increment: 1 } },
    });

    this.logger.log(
      `Complaint logged: ${input.type}/${input.severity} for patient ${campaignPatientId}`,
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

    await this.sessionsService.deleteCampaignSession(session.phone);

    if (notificationPhone) {
      try {
        await this.whatsappService.sendText(
          notificationPhone,
          `🔴 Handoff Required\nPatient: ${session.phone}\nReason: ${input.reason}`,
        );
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

  private detectLanguage(message: string): Language {
    if (/[\u0600-\u06FF]/.test(message)) return Language.AR;

    const lower = message.toLowerCase();

    const frenchWords  = ['bonjour', 'merci', 'oui', 'non', 'je', 'vous', 'comment', 'bien', 'bonsoir', 'salam'];
    const englishWords = ['hello', 'hi', 'thanks', 'yes', 'no', 'good', 'how', 'please', 'fine'];

    if (frenchWords.some(w  => lower.includes(w))) return Language.FR;
    if (englishWords.some(w => lower.includes(w))) return Language.EN;

    return Language.FR; // default to clinic language
  }

  private async resolveAiMaxTurns(campaignId: string, clinicAiMaxTurns: number): Promise<number> {
    const campaign = await this.prisma.campaign.findUnique({
      where:  { id: campaignId },
      select: { aiMaxTurns: true },
    });
    return campaign?.aiMaxTurns ?? clinicAiMaxTurns;
  }

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