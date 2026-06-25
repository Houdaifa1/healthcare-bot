import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Groq from 'groq-sdk';
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

// ─── Groq tool definitions (OpenAI function-calling format) ───────────────────

const GROQ_TOOLS: any[] = [
  {
    type: 'function',
    function: {
      name: 'log_complaint',
      description: 'Log a patient complaint or medical concern detected in the conversation. Call this whenever the patient expresses dissatisfaction, reports a medical issue, or describes an urgent situation.',
      parameters: {
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
  },
  {
    type: 'function',
    function: {
      name: 'request_booking',
      description: 'Create a booking request when the patient expresses intent to schedule a new appointment or follow-up visit.',
      parameters: {
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
  },
  {
    type: 'function',
    function: {
      name: 'request_handoff',
      description: 'Transfer the conversation to a human staff member. Use when the patient is very distressed, the situation is too complex for AI, the patient explicitly asks for a human, or there is an urgent medical situation.',
      parameters: {
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
  },
  {
    type: 'function',
    function: {
      name: 'end_conversation',
      description: 'Close the conversation when the follow-up is complete. Call this when the patient has no more concerns, has been helped, or has clearly disengaged.',
      parameters: {
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
  },
];

// ─── Groq model ──────────────────────────────────────────────────────────────

const GROQ_MODEL = 'llama-3.3-70b-versatile';

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);
  private client: Groq | null;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly sessionsService: SessionsService,
    private readonly whatsappService: WhatsAppService,
  ) {
    const apiKey = this.configService.get<string>('GROQ_API_KEY');
    if (apiKey) {
      this.client = new Groq({ apiKey });
      this.logger.log('Groq AI initialized for campaign conversations');
    } else {
      this.client = null;
      this.logger.warn('GROQ_API_KEY not set — AI conversation engine disabled until configured');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC ENTRY POINT — called by MessageProcessor
  // ═══════════════════════════════════════════════════════════════════════════

  async handleReply(phone: string, patientMessage: string): Promise<void> {
    if (!this.client) {
      this.logger.error('Cannot handle reply — GROQ_API_KEY is not set');
      return;
    }

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
    if (session.language === null) {
      const detected = this.detectLanguage(patientMessage);
      session.language = detected;

      await this.prisma.campaignPatient.update({
        where: { id: campaignPatient.id },
        data: { language: detected },
      });

      this.logger.log(`Language detected for ${phone}: ${detected}`);
    }

    // ── 6. Mark as REPLIED on first reply ─────────────────────────────────
    if (campaignPatient.status === CampaignPatientStatus.CONTACTED) {
      await this.prisma.campaignPatient.update({
        where: { id: campaignPatient.id },
        data: {
          status: CampaignPatientStatus.REPLIED,
          repliedAt: new Date(),
        },
      });

      await this.prisma.campaign.update({
        where: { id: campaignPatient.campaignId },
        data: { repliedCount: { increment: 1 } },
      });
    }

    // ── 7. Update session status to active ────────────────────────────────
    session.status = 'active';

    // ── 8. Append patient message to session ──────────────────────────────
    const userMessage: CampaignMessage = {
      role: 'user',
      content: patientMessage,
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

    // ── 11. Build messages array ───────────────────────────────────────────
    const systemPrompt = this.buildSystemPrompt(session, campaignPatient);
    const messages = this.buildMessages(session);

    // ── 12. Call Groq ──────────────────────────────────────────────────────
    const response = await this.callGroq(systemPrompt, messages, aiMaxTurns);

    // ── 13. Execute tool calls ────────────────────────────────────────────
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
        role: 'assistant',
        content: textReply,
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
        messages: session.messages as any,
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
    session: CampaignSession,
    campaignPatient: { patientSnapshot: any; patientName: string; visitDate: Date; prestation: string; medecinTraitant: string; ageYears: number | null; sexe: string | null; ville: string | null },
  ): string {
    const snapshot = campaignPatient.patientSnapshot as Record<string, any>;
    const historyData = snapshot?.history ?? null;
    const language = session.language ?? Language.FR;

    const languageInstruction = language === Language.EN
      ? 'Always respond in English.'
      : language === Language.AR
        ? 'Respond in Moroccan Darija (Arabic). Use simple, clear language.'
        : 'Always respond in French. Use polite, professional "vous" form.';

    let historySection = 'No previous admission history available.';
    if (historyData?.admissions && Array.isArray(historyData.admissions) && historyData.admissions.length > 0) {
      const admissions = historyData.admissions
        .slice(0, 10)
        .map((a: any, i: number) => {
          const date = a.date_admission ? new Date(a.date_admission).toLocaleDateString('fr-FR') : 'Unknown date';
          const motif = a.motif_admission ?? 'Unknown';
          const doctor = a.medecin_traitant ?? 'Unknown';
          const actes = Array.isArray(a.actes_realises) && a.actes_realises.length > 0
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
  // BUILD MESSAGES ARRAY
  // ═══════════════════════════════════════════════════════════════════════════

  private buildMessages(
    session: CampaignSession,
  ): any[] {
    return session.messages
      .filter(m => m.content?.trim())
      .map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CALL GROQ API
  // ═══════════════════════════════════════════════════════════════════════════

  private async callGroq(
    systemPrompt: string,
    messages: any[],
    aiMaxTurns: number,
  ): Promise<any> {
    const maxTokens = Math.min(1024, Math.max(256, aiMaxTurns * 20));

    try {
      const result = await this.client!.chat.completions.create({
        model: GROQ_MODEL,
        max_tokens: maxTokens,
        temperature: 0.7,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
        tools: GROQ_TOOLS,
        tool_choice: 'auto',
      });
      this.logger.debug(`Raw Groq response: ${JSON.stringify(result.choices[0]?.message)}`);
      return result;
    } catch (err: any) {
      // Groq returns 400 when the model generates malformed tool calls
      // (e.g., <function=...> text format). Parse failed_generation and
      // return a synthetic response so processResponse can handle it.
      const errorBody = err?.response?.data ?? err?.message ?? '';
      const errorStr = typeof errorBody === 'string' ? errorBody : JSON.stringify(errorBody);

      const failedGenMatch = errorStr.match(/"failed_generation"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (failedGenMatch) {
        const failedGen = failedGenMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
        this.logger.warn(`Groq tool call failed — parsing failed_generation as text`);

        return {
          choices: [{
            message: {
              content: failedGen,
              tool_calls: null,
            },
          }],
        };
      }

      this.logger.error(`Groq API error: ${errorStr}`);
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROCESS RESPONSE — execute tools, extract text
  // ═══════════════════════════════════════════════════════════════════════════

  private async processResponse(
    response: any,
    session: CampaignSession,
    campaignPatientId: string,
    campaignId: string,
    notificationPhone: string | null,
    rawPatientMessage: string,
  ): Promise<{ textReply: string | null; conversationEnded: boolean }> {
    let textReply: string | null = null;
    let conversationEnded: boolean = false;

    const choice = response.choices[0];
    if (!choice) {
      this.logger.warn('Groq returned no choices');
      return { textReply: null, conversationEnded: false };
    }

    const msg = choice.message;

    // ── Extract text content ─────────────────────────────────────────────
    if (msg.content?.trim()) {
      textReply = msg.content.trim();
    }

    // ── Process tool calls (structured) ───────────────────────────────────
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const toolCall of msg.tool_calls) {
        const name = toolCall.function.name;
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          this.logger.warn(`Failed to parse tool arguments for ${name}: ${toolCall.function.arguments}`);
          continue;
        }

        this.logger.log(`Tool called: ${name} — input: ${JSON.stringify(args)}`);
        const result = await this.executeToolCall(name, args, session, campaignPatientId, campaignId, notificationPhone, rawPatientMessage);
        if (result.ended) conversationEnded = true;
      }
    }

    // ── Parse text for tool calls (Groq open-source model fallback) ───────
    // Some models generate tool calls as text instead of using the function calling API.
    // Pattern: <function=tool_name{json_args}></function> or similar
    if (msg.content) {
      const textToolCalls = this.extractToolCallsFromText(msg.content);
      for (const { name, args } of textToolCalls) {
        this.logger.log(`Tool called (from text): ${name} — input: ${JSON.stringify(args)}`);
        const result = await this.executeToolCall(name, args, session, campaignPatientId, campaignId, notificationPhone, rawPatientMessage);
        if (result.ended) conversationEnded = true;
      }
      // Strip tool call text from the reply before sending to user
      if (textToolCalls.length > 0) {
        let cleaned = msg.content;
        for (const { raw } of textToolCalls) {
          cleaned = cleaned.replace(raw, '').trim();
        }
        if (cleaned) {
          textReply = cleaned;
        } else {
          textReply = null; // No text left after stripping tool calls
        }
      }
    }

    return { textReply, conversationEnded };
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

    this.logger.log(
      `Complaint logged: ${input.type} / ${input.severity} for patient ${campaignPatientId}`,
    );
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
    notificationPhone: string | null,
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

    await this.sessionsService.deleteCampaignSession(session.phone);

    if (notificationPhone) {
      try {
        const msg =
          `🔴 Handoff Required\n` +
          `Patient: ${session.phone}\n` +
          `Reason: ${input.reason}`;
        await this.whatsappService.sendText(notificationPhone, msg);
      } catch (err: any) {
        this.logger.error(`Failed to notify staff of handoff: ${err.message}`);
      }
    }

    this.logger.log(
      `Handoff executed for patient ${campaignPatientId} — reason: ${input.reason}`,
    );
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

    this.logger.log(
      `Conversation closed for patient ${campaignPatientId} — outcome: ${outcome}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL CALL EXECUTOR (shared by structured + text-parsed calls)
  // ═══════════════════════════════════════════════════════════════════════════

  private async executeToolCall(
    name: string,
    args: Record<string, unknown>,
    session: CampaignSession,
    campaignPatientId: string,
    campaignId: string,
    notificationPhone: string | null,
    rawPatientMessage: string,
  ): Promise<{ ended: boolean }> {
    switch (name) {
      case 'log_complaint': {
        const input = args as unknown as LogComplaintInput;
        await this.executeLogComplaint(input, campaignPatientId, session.clinicId, rawPatientMessage, campaignId);
        return { ended: false };
      }
      case 'request_booking': {
        const input = args as unknown as RequestBookingInput;
        await this.executeRequestBooking(input, campaignPatientId, session.clinicId, rawPatientMessage);
        return { ended: false };
      }
      case 'request_handoff': {
        const input = args as unknown as RequestHandoffInput;
        await this.executeRequestHandoff(input, session, campaignPatientId, campaignId, notificationPhone);
        return { ended: true };
      }
      case 'end_conversation': {
        const input = args as unknown as EndConversationInput;
        await this.closeConversation(session, campaignPatientId, campaignId, input.outcome);
        return { ended: true };
      }
      default:
        this.logger.warn(`Unknown tool called: ${name}`);
        return { ended: false };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEXT-BASED TOOL CALL PARSER (Groq open-source model fallback)
  // ═══════════════════════════════════════════════════════════════════════════

  private extractToolCallsFromText(text: string): { name: string; args: Record<string, unknown>; raw: string }[] {
    const results: { name: string; args: Record<string, unknown>; raw: string }[] = [];

    // Pattern 1: <function=tool_name{json}></function>
    const fnPattern = /<function=(\w+)\{([^}]*)\}><\/function>/g;
    let match;
    while ((match = fnPattern.exec(text)) !== null) {
      const name = match[1];
      const argsStr = match[2];
      try {
        const args = JSON.parse('{' + argsStr + '}');
        results.push({ name, args, raw: match[0] });
      } catch {
        this.logger.warn(`Failed to parse text tool call: ${match[0]}`);
      }
    }

    // Pattern 2: ```json\n{"tool": "name", ...}\n```
    const jsonBlockPattern = /```json\n(\{[^}]*"tool"[^}]*\})\n```/g;
    while ((match = jsonBlockPattern.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.tool) {
          const { tool, ...args } = parsed;
          results.push({ name: tool, args, raw: match[0] });
        }
      } catch {
        // ignore
      }
    }

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  private detectLanguage(message: string): Language {
    if (/[\u0600-\u06FF]/.test(message)) return Language.AR;

    const lower = message.toLowerCase();

    const frenchWords = ['bonjour', 'merci', 'oui', 'non', 'je', 'vous', 'comment', 'bien', 'bonsoir', 'salam'];
    if (frenchWords.some(w => lower.includes(w))) return Language.FR;

    const englishWords = ['hello', 'hi', 'thanks', 'yes', 'no', 'good', 'how', 'please', 'fine'];
    if (englishWords.some(w => lower.includes(w))) return Language.EN;

    return Language.FR;
  }

  private async resolveAiMaxTurns(campaignId: string, clinicAiMaxTurns: number): Promise<number> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { aiMaxTurns: true },
    });
    return campaign?.aiMaxTurns ?? clinicAiMaxTurns;
  }

  async fetchBotMessage(
    clinicId: string,
    key: MessageKey,
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