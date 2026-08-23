import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService, CampaignSession, CampaignMessage } from '../sessions/sessions.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { HandoffService } from '../handoff/handoff.service';
import { OllamaProvider } from './providers/ollama.provider';
import { AIMessage, AIInputMessage, AIToolDefinition, AITextBlock, AIToolUseBlock } from './providers/ai-response.types';
import {
  AppointmentStatus,
  CampaignPatientStatus,
  ComplaintSeverity,
  ComplaintType,
  ConversationOutcome,
  Language,
  MessageKey,
  BookingRequestStatus,
  BookingSource,
} from '@prisma/client';

// ─── Tool input shapes ────────────────────────────────────────────────────────

interface LogComplaintInput {
  type: ComplaintType;
  severity: ComplaintSeverity;
  summary: string;
}

interface RequestBookingInput {
  preferredSpecialty?: string;
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

const AI_TOOLS: AIToolDefinition[] = [
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
          description: 'A clear 1-2 sentence summary written in the same language the patient used.',
        },
      },
      required: ['type', 'severity', 'summary'],
    },
  },
  {
    name: 'request_booking',
    description:
      'Create or update a booking request when the patient wants to schedule a new appointment. ' +
      'IMPORTANT: Before calling this tool you MUST have collected ALL of the following through conversation: ' +
      '(1) the reason for the appointment, ' +
      '(2) a preferred doctor or specialty (ask if not mentioned), ' +
      '(3) a preferred date or date range. ' +
      'Ask for each missing piece one at a time — one question per message. ' +
      'Do NOT call this tool until reason and preferredDateRange are known. ' +
      'This is a silent side effect — always follow it with a warm confirmation to the patient.',
    input_schema: {
      type: 'object',
      properties: {
        preferredSpecialty: { type: 'string', description: 'Specialty or department the patient wants, e.g. "cardiologie", "généraliste".' },
        preferredDoctor: { type: 'string', description: 'Doctor name if the patient mentioned one.' },
        preferredDateRange: { type: 'string', description: 'Date or date range as the patient expressed it, e.g. "semaine prochaine", "next Monday", "le 5 juillet".' },
        reason: { type: 'string', description: 'Reason for the new appointment as the patient expressed it.' },
      },
      required: ['reason', 'preferredDateRange'],
    },
  },
  {
    name: 'request_handoff',
    description:
      'Transfer the conversation to a human staff member. ' +
      'Use when: the patient explicitly asks for a human, the patient is very distressed, ' +
      'the situation is medically complex, or severity is HIGH. ' +
      'IMPORTANT: If the patient complained AND wants a human, call log_complaint first, then request_handoff, in the SAME turn. ' +
      'PRIORITY RULE: If the patient explicitly asks to speak to a human/staff member, OR uses words like ' +
      '"maintenant", "urgent", "immédiatement", "right now", "immediately" together with a health concern, ' +
      'you MUST call request_handoff. NEVER call log_complaint alone when the patient has explicitly requested a human. ' +
      'This ends the AI conversation — always send a warm farewell text before calling this.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Clear explanation for the staff member who will take over.' } },
      // `reason` is optional: a local model frequently emits request_handoff with
      // an empty input ({}). If `reason` were required, the provider would DROP the
      // tool call and the patient's request for a human would be silently ignored.
      required: [],
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

const MAX_TOOL_LOOPS = 6;
const COMPLAINT_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

// PRODUCTION FIX: broadened leak detection. The old pattern only caught
// "toolname(" / "toolname{" syntax. Now also catches JSON-key-style leaks
// (e.g. `"name": "log_complaint"`), code fences, and raw model artifacts —
// all forms a small local model can produce even under a JSON-schema
// contract if it echoes something odd in the "reply" field itself.
const TOOL_NAMES = ['log_complaint', 'request_booking', 'request_handoff', 'end_conversation'] as const;
const TOOL_LEAK_PATTERNS: RegExp[] = [
  new RegExp(`(?:${TOOL_NAMES.join('|')})\\s*[\\(\\{]`, 'i'),
  new RegExp(`"name"\\s*:\\s*"(?:${TOOL_NAMES.join('|')})"`, 'i'),
  /"tool_calls"\s*:/i,
  /```/,
  /<think>|<\/think>|<\|im_start\|>|<\|im_end\|>/i,
];

// ─── Enum normalization ───────────────────────────────────────────────────────
// Local models routinely emit enum values in lowercase, spaced, hyphenated or
// camelCase forms ("medical concern", "medical-concern", "medicalConcern",
// "complaint", "urgent"). Prisma strictly rejects anything that isn't the exact
// enum token, and a bare `.toUpperCase()` only fixes the lowercase case — it
// silently corrupts the spaced/hyphenated/camel forms into an invalid token
// that fails the DB write. Normalize defensively here and return null when the
// value genuinely cannot be mapped so callers fail loudly instead of writing
// wrong data.

function normalizeEnumToken<T extends string>(value: unknown, valid: readonly T[]): T | null {
  if (value === null || value === undefined) return null;
  const token = String(value)
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2') // camelCase → snake_case
    .replace(/[-\s]+/g, '_')                 // hyphens / spaces → underscore
    .toUpperCase();
  return (valid as readonly string[]).includes(token) ? (token as T) : null;
}

const COMPLAINT_TYPE_VALUES: readonly ComplaintType[] = [
  ComplaintType.COMPLAINT,
  ComplaintType.MEDICAL_CONCERN,
  ComplaintType.URGENT,
];

const COMPLAINT_SEVERITY_VALUES: readonly ComplaintSeverity[] = [
  ComplaintSeverity.LOW,
  ComplaintSeverity.MEDIUM,
  ComplaintSeverity.HIGH,
];

// Local models sometimes invent a "service concern" category for service/behaviour
// complaints. The schema only has COMPLAINT (service/experience), MEDICAL_CONCERN
// (health) and URGENT — so map any "service" wording onto COMPLAINT instead of
// failing the write.
const COMPLAINT_TYPE_ALIASES: Record<string, ComplaintType> = {
  SERVICE_CONCERN:   ComplaintType.COMPLAINT,
  SERVICE_COMPLAINT: ComplaintType.COMPLAINT,
};

function normalizeComplaintType(value: unknown): ComplaintType | null {
  if (typeof value === 'string') {
    const key = value.trim().replace(/[-\s]+/g, '_').toUpperCase();
    const alias = COMPLAINT_TYPE_ALIASES[key];
    if (alias) return alias;
  }
  return normalizeEnumToken(value, COMPLAINT_TYPE_VALUES);
}

function normalizeComplaintSeverity(value: unknown): ComplaintSeverity | null {
  return normalizeEnumToken(value, COMPLAINT_SEVERITY_VALUES);
}

// Human-readable labels used in staff notifications (the clinic operates in
// French). Raw enum tokens and internal ids must never leak into a WhatsApp
// message sent to staff.
const COMPLAINT_TYPE_LABELS: Record<ComplaintType, string> = {
  COMPLAINT:        'Plainte service',
  MEDICAL_CONCERN:  'Préoccupation médicale',
  URGENT:           'Urgence',
};

const COMPLAINT_SEVERITY_LABELS: Record<ComplaintSeverity, string> = {
  LOW:     'Faible',
  MEDIUM:  'Moyenne',
  HIGH:    'Élevée',
};

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionsService: SessionsService,
    private readonly whatsappService: WhatsAppService,
    private readonly handoffService: HandoffService,
    private readonly ollamaProvider: OllamaProvider,
  ) {
    this.logger.log('ConversationService initialized — Ollama local model only, no cloud fallback');
  }

  async handleReply(phone: string, patientMessage: string): Promise<void> {
    this.logger.log(`Campaign reply from ${phone}: "${patientMessage}"`);

    const session = await this.sessionsService.getCampaignSession(phone);
    if (!session) {
      this.logger.error(`No campaign session found for ${phone}`);
      return;
    }

    if (session.status === 'completed') {
      this.logger.warn(`Session for ${phone} is completed — ignoring`);
      return;
    }

    if (session.status === 'handed_off' || session.status === 'admin_handling') {
      this.logger.log(`Session for ${phone} is handed off to staff — AI ignoring reply`);
      return;
    }

    const campaignPatient = await this.prisma.campaignPatient.findUnique({
      where: { id: session.campaignPatientId },
      include: { campaign: true },
    });

    if (!campaignPatient) {
      this.logger.error(`CampaignPatient ${session.campaignPatientId} not found — purging orphaned session`);
      await this.sessionsService.deleteCampaignSession(phone);
      return;
    }

    const clinic = await this.prisma.clinic.findUnique({ where: { id: session.clinicId } });
    if (!clinic) {
      this.logger.error(`Clinic ${session.clinicId} not found`);
      return;
    }

    const detectedLang = this.detectLanguage(patientMessage);
    const resolvedLang = detectedLang ?? session.language ?? Language.FR;

    if (session.language !== resolvedLang) {
      session.language = resolvedLang;
      await this.prisma.campaignPatient.update({ where: { id: campaignPatient.id }, data: { language: resolvedLang } });
      this.logger.log(`Language updated for ${phone}: ${resolvedLang}`);
    }

    if (campaignPatient.status === CampaignPatientStatus.CONTACTED) {
      await this.prisma.campaignPatient.update({
        where: { id: campaignPatient.id },
        data: { status: CampaignPatientStatus.REPLIED, repliedAt: new Date() },
      });
      await this.prisma.campaign.update({ where: { id: campaignPatient.campaignId }, data: { repliedCount: { increment: 1 } } });
    }

    session.status = 'active';

    const isDuplicate = session.messages.some(
      m => m.role === 'user' && m.content === patientMessage && Date.now() - m.timestamp < 10_000,
    );
    if (!isDuplicate) {
      session.messages.push({ role: 'user', content: patientMessage, timestamp: Date.now() });
    }

    const aiMaxTurns = campaignPatient.campaign?.aiMaxTurns ?? clinic.aiMaxTurns;

    if (session.turnCount >= aiMaxTurns) {
      this.logger.warn(`Turn limit (${aiMaxTurns}) reached for ${phone} — closing`);
      const farewell = await this.fetchBotMessage(clinic.id, MessageKey.CAMPAIGN_FAREWELL_MESSAGE, session.language ?? Language.FR);
      if (farewell) await this.whatsappService.sendText(phone, farewell);
      await this.closeConversation(session, campaignPatient.id, campaignPatient.campaignId, ConversationOutcome.COMPLETED);
      return;
    }

    const systemPrompt = this.buildSystemPrompt(session, campaignPatient, clinic);

    // NOTE: aiMessages is the LOCAL, in-memory conversation view sent to the
    // provider for THIS turn's tool-calling loop. It is allowed to contain
    // raw tool call / tool result blocks — the model needs to see those to
    // continue a multi-step loop within a single turn. This is intentionally
    // separate from session.messages (below), which is the PERSISTED,
    // cross-turn history. session.messages must never contain raw tool JSON
    // — see the leak-prevention note further down.
    const aiMessages = this.buildAiMessages(session);

    let conversationEnded = false;
    let loopCount = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let lastUsedModel = 'unknown';
    let complaintLoggedThisTurn = false;
    let bookingRecordedThisTurn = false;
    let textSent = false;

    while (loopCount < MAX_TOOL_LOOPS && !conversationEnded) {
      let response: AIMessage;

      try {
        response = await this.ollamaProvider.generate(systemPrompt, aiMessages, AI_TOOLS);
      } catch (err: any) {
        this.logger.error(`Ollama call failed for ${phone}: ${err.message}`);
        const errMsg = (session.language ?? Language.FR) === Language.EN
          ? 'Sorry, I encountered a technical issue. Please try again in a few minutes.'
          : 'Désolé, je rencontre un problème technique. Veuillez réessayer dans quelques minutes.';
        await this.whatsappService.sendText(phone, errMsg);
        // Persist the (already recorded) user message before bailing out, so a
        // transient AI outage doesn't silently drop the patient's message from
        // the conversation history.
        await this.sessionsService.saveCampaignSession(session);
        return;
      }

      // Persist provider response to internal audit (best-effort). This helps
      // with post-mortems when tool calls are mis-parsed or dropped.
      try {
        await this.persistAudit(`audit:provider:${phone}`, {
          ts: Date.now(),
          model: response.model,
          stop_reason: response.stop_reason,
          content: response.content,
          usage: response.usage ?? null,
        });
      } catch { /* best-effort */ }

      lastUsedModel = response.model;

      if (response.stop_reason === 'max_tokens') {
        this.logger.warn(`AI response truncated (max_tokens) for ${phone} — sending clean fallback`);
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

      const textBlocks = response.content.filter((b): b is AITextBlock => b.type === 'text' && b.text.trim().length > 0);
      const toolUseBlocks = response.content.filter((b): b is AIToolUseBlock => b.type === 'tool_use');

      const rawTextReply = textBlocks.map(b => b.text).join(' ').trim();

      const textReply = this.sanitizeTextReply(rawTextReply, phone, toolUseBlocks.length > 0, session.language);

      const sendTextOnce = async () => {
        if (textSent || !textReply) return;
        textSent = true;
        await this.whatsappService.sendText(phone, textReply);
        // This is the ONLY place session.messages receives an 'assistant'
        // entry — always sanitized, human-readable text, never raw tool
        // JSON. This is what future turns will see as conversation history.
        session.messages.push({ role: 'assistant', content: textReply, timestamp: Date.now() });
      };

      const toolResults: { type: 'tool_result'; tool_use_id: string; content: string }[] = [];
      let highSeverityComplaintLogged = false;
      let handoffCalledThisTurn = false;

      // ── Tool ordering fix ────────────────────────────────────────────────
      // Side-effect tools (log_complaint, request_booking) MUST run before any
      // terminal tool (request_handoff, end_conversation). The model is told to
      // emit them in that order, but a local model can still return
      // [request_handoff, log_complaint] in a single turn. The previous code
      // broke out of the loop as soon as a terminal tool set conversationEnded,
      // which silently DROPPED the complaint/booking side effect that came after
      // it. Partitioning guarantees side effects always execute first.
      const SIDE_EFFECT_TOOL_NAMES = new Set(['log_complaint', 'request_booking']);
      const orderedToolBlocks = [
        ...toolUseBlocks.filter((b) => SIDE_EFFECT_TOOL_NAMES.has(b.name)),
        ...toolUseBlocks.filter((b) => !SIDE_EFFECT_TOOL_NAMES.has(b.name)),
      ];

      for (const toolBlock of orderedToolBlocks) {
        this.logger.log(`Tool: ${toolBlock.name} — ${JSON.stringify(toolBlock.input)}`);

        let resultContent = 'Success';
        try {
          if (toolBlock.name === 'log_complaint') {
            const input = toolBlock.input as unknown as LogComplaintInput;
            const wasLogged = await this.executeLogComplaint(
              input, campaignPatient.id, clinic.id, patientMessage, campaignPatient.campaignId, clinic,
              { name: campaignPatient.patientName, phone: campaignPatient.phone },
            );
            resultContent = 'Complaint logged successfully.';
            if (wasLogged) complaintLoggedThisTurn = true;

            const severity = normalizeComplaintSeverity(input.severity);
            if (severity === ComplaintSeverity.HIGH) highSeverityComplaintLogged = true;

          } else if (toolBlock.name === 'request_booking') {
            await this.executeRequestBooking(
              toolBlock.input as unknown as RequestBookingInput, campaignPatient.id, clinic.id, patientMessage,
            );
            resultContent = 'Booking request recorded.';
            bookingRecordedThisTurn = true;

          } else if (toolBlock.name === 'request_handoff') {
            handoffCalledThisTurn = true;
            await sendTextOnce();
            await this.executeRequestHandoff(
              toolBlock.input as unknown as RequestHandoffInput, session, campaignPatient, clinic,
            );
            resultContent = 'Handoff executed.';
            conversationEnded = true;

          } else if (toolBlock.name === 'end_conversation') {
            await sendTextOnce();
            await this.closeConversation(
              session, campaignPatient.id, campaignPatient.campaignId,
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
        if (conversationEnded) break;
      }

      if (highSeverityComplaintLogged && !handoffCalledThisTurn && !conversationEnded) {
        this.logger.warn(`HIGH severity complaint logged without request_handoff for ${phone} — auto-escalating`);
        await sendTextOnce();
        try {
          await this.executeRequestHandoff(
            { reason: 'Auto-escalated by system: HIGH severity complaint logged without explicit handoff.' },
            session, campaignPatient, clinic,
          );
          conversationEnded = true;
        } catch (err: any) {
          this.logger.error(`Auto-escalation handoff failed for ${phone}: ${err.message}`);
        }
      }

      if (conversationEnded) break;

      if (toolUseBlocks.length === 0) {
        await sendTextOnce();
        break;
      }

      // PRODUCTION FIX (leak prevention): the assistant/tool-result exchange
      // is pushed to `aiMessages` ONLY — the local, in-memory array used to
      // continue this turn's tool loop with the provider. It is NEVER pushed
      // to `session.messages` anymore. Previously this code also did:
      //   session.messages.push({ role: 'assistant', content: JSON.stringify(response.content), ... })
      //   session.messages.push({ role: 'user', content: JSON.stringify(toolResults), ... })
      // which persisted raw tool-call JSON into the conversation history
      // fed back to the model on EVERY future turn via buildAiMessages().
      // That created two problems: (1) the model could pattern-echo JSON
      // fragments into future patient-facing replies, and (2) staff-facing
      // conversation views would show raw JSON instead of readable text.
      // The only human-readable content ever stored is pushed via
      // sendTextOnce() above. If a turn produces tool calls with no text
      // reply at all, nothing is added to session.messages for that turn —
      // which is correct, since the DB side effects (Complaint,
      // BookingRequest rows) already recorded what happened; the
      // conversation transcript doesn't need a JSON stand-in for it.
      aiMessages.push({ role: 'assistant', content: response.content as any });
      aiMessages.push({ role: 'user', content: toolResults as any });

      loopCount++;
    }

    // NOTE: the separate "classify_complaint" second model call was removed.
    // It doubled per-turn latency (two full model generations per message) and
    // produced false positives (e.g. flagging "give me my visit details" as a
    // MEDICAL_CONCERN). The main model now reliably calls log_complaint directly
    // via the tool loop above, so a redundant second pass is unnecessary.

    // ── Guarantee a patient-facing reply ───────────────────────────────────
    // A small local model can emit only tool calls with an empty `reply` field,
    // or loop on a side-effect tool without ever writing text (e.g. it keeps
    // re-calling log_complaint). The patient must NEVER be left silent: if the
    // turn did not send any text and the conversation is still open, send a
    // language-appropriate acknowledgment that reflects what actually happened.
    if (!textSent && !conversationEnded) {
      const fallback = this.buildFallbackAcknowledgment(
        session.language ?? Language.FR,
        complaintLoggedThisTurn,
        bookingRecordedThisTurn,
      );
      this.logger.warn(`No model text produced for ${phone} — sending fallback acknowledgment`);
      await this.whatsappService.sendText(phone, fallback);
      session.messages.push({ role: 'assistant', content: fallback, timestamp: Date.now() });
    }

    session.turnCount += 1;

    try {
      await this.prisma.aiUsage.create({
        data: {
          campaignPatientId: campaignPatient.id,
          clinicId: clinic.id,
          campaignId: campaignPatient.campaignId,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          model: lastUsedModel,
        },
      });
    } catch (err: any) {
      this.logger.warn(`Failed to log AI usage: ${err.message}`);
    }

    await this.prisma.campaignPatient.update({
      where: { id: campaignPatient.id },
      data: { messages: session.messages as any, turnCount: session.turnCount },
    });

    if (!conversationEnded) {
      await this.sessionsService.saveCampaignSession(session);
    }

    this.logger.log(`Turn ${session.turnCount}/${aiMaxTurns} complete for ${phone} (model: ${lastUsedModel})`);
  }

  private buildFallbackAcknowledgment(
    language: Language,
    complaintLogged: boolean,
    bookingRecorded: boolean,
  ): string {
    if (complaintLogged) {
      return language === Language.EN
        ? "Thank you for letting me know. I've noted your feedback and our team will follow up with you shortly."
        : "Merci de m'avoir fait part de votre retour. J'ai bien noté votre message et notre équipe vous recontactera rapidement.";
    }
    if (bookingRecorded) {
      return language === Language.EN
        ? "I've recorded your booking request. Our team will contact you shortly to confirm the details."
        : "J'ai bien enregistré votre demande de rendez-vous. Notre équipe vous contactera rapidement pour confirmer les détails.";
    }
    return language === Language.EN
      ? "I'm here to help. Could you tell me a bit more about what you need?"
      : "Je suis là pour vous aider. Pouvez-vous m'en dire un peu plus ?";
  }

  private buildSystemPrompt(
    session: CampaignSession,
    campaignPatient: {
      patientSnapshot: any; patientName: string; visitDate: Date; prestation: string;
      medecinTraitant: string; ageYears: number | null; sexe: string | null; ville: string | null;
    },
    clinic: { name: string; phone: string; address?: string | null; notificationPhone?: string | null },
  ): string {
    const language = session.language ?? Language.FR;
    const snapshot = campaignPatient.patientSnapshot as Record<string, any>;
    const historyData = snapshot?.history ?? null;

    const languageInstruction = language === Language.EN
      ? `LANGUAGE LOCK: You are strictly locked to English. Every single word you output MUST be in English. Do not use French under any circumstances.`
      : `LANGUE: Vous êtes strictement verrouillé en français. Chaque mot que vous écrivez DOIT être en français. N'utilisez pas l'anglais.`;

    let historySection = 'Aucun historique disponible.';
    if (historyData?.admissions && Array.isArray(historyData.admissions) && historyData.admissions.length > 0) {
      const lines = historyData.admissions
        .slice(0, 10)
        .map((a: any, i: number) => {
          const date = a.date_admission ? new Date(a.date_admission).toLocaleDateString('fr-FR') : 'Date inconnue';
          const motif = a.motif_admission ?? 'Inconnu';
          const doctor = a.medecin_traitant ?? 'Inconnu';
          const actes = Array.isArray(a.actes_realises) && a.actes_realises.length > 0 ? a.actes_realises.join(', ') : 'Aucun acte enregistré';
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

RULES:
- No emojis. 2-4 short sentences max. One question per message max. Never mention other patients.
- Use time-neutral greetings ("Salut"/"Hello"), not "Bonjour"/"Bonsoir"/"Good morning".
- You are NOT a doctor. NEVER diagnose, suggest treatments, or ask triage questions (e.g. "where does it hurt?", "how long has it lasted?"). If a patient mentions a symptom/pain, log it and reply with empathy ONLY.
- If the message is unclear, a typo, or gibberish, do NOT read it as a complaint, booking, or goodbye — just ask the patient to clarify.

TOOLS — key rules (the tool schemas are also listed below):
- log_complaint: call for ANY dissatisfaction, symptom, pain, health concern, or urgency. type=COMPLAINT for service/staff complaints, MEDICAL_CONCERN for health symptoms, URGENT for emergencies. Do NOT call for a plain request for information (visit details, results, hours) — just answer. It is silent: always also send a warm empathetic text reply. Call once per issue.
- request_booking: only after collecting reason + preferred date + doctor/specialty (one question at a time). Confirm warmly after.
- request_handoff: when the patient asks for a human, is very distressed, or severity is HIGH. Call log_complaint FIRST if they also complained. This ends the conversation.
- end_conversation: only when the patient clearly says goodbye or has nothing more. NEVER close after a single short message ("hi", "ok", "yeah") or a single "I'm fine" — those are engagement, not goodbyes. Ask one gentle follow-up first.

NEVER write a tool's name or arguments as visible text — output ONLY the tool call plus a natural-language reply.

PATIENT INFORMATION:
- Name: ${campaignPatient.patientName}
- Age: ${campaignPatient.ageYears ?? 'Unknown'}
- Sex: ${campaignPatient.sexe ?? 'Unknown'}
- City: ${campaignPatient.ville ?? 'Unknown'}
- Last visit: ${visitDate} — ${campaignPatient.prestation} (Dr. ${campaignPatient.medecinTraitant})

PATIENT HISTORY:
 ${historySection}

CLINIC: ${clinic.phone}${clinic.address ? ` — ${clinic.address}` : ''}

GOAL: Follow up on the patient's wellbeing after their visit. Acknowledge warmly, use the tools, respond empathetically.

Current turn: ${session.turnCount + 1}`;
  }

  private buildAiMessages(session: CampaignSession): { role: 'user' | 'assistant'; content: any }[] {
    const language = session.language ?? Language.FR;
    const languageReminder = language === Language.EN ? '[Respond in English]' : '[Répondez en français]';

    // session.messages is now guaranteed to contain only plain, human-
    // readable strings going forward (see the leak-prevention fix in
    // handleReply). The JSON.parse branch below is kept ONLY as a defensive
    // fallback for legacy sessions saved by the old buggy code before this
    // fix was deployed — new turns will never produce content that needs it.
    const messages = session.messages
      .filter(m => m.content?.trim())
      .map(m => {
        let content: any = m.content;
        if (typeof m.content === 'string' && (m.content.trim().startsWith('[') || m.content.trim().startsWith('{'))) {
          try { content = JSON.parse(m.content); } catch { /* keep as string */ }
        }
        return { role: m.role, content };
      });

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && typeof messages[i].content === 'string') {
        messages[i] = { ...messages[i], content: `${messages[i].content}\n\n${languageReminder}` };
        break;
      }
    }

    return messages;
  }

  /**
   * Returns true if a new Complaint row was actually created (false if
   * skipped as a duplicate). Callers use this to know whether the
   * model-driven classifier safety net still needs to fire.
   */
  private async executeLogComplaint(
    input: LogComplaintInput,
    campaignPatientId: string,
    clinicId: string,
    triggeringMessage: string,
    campaignId: string,
    clinic: { id: string; notificationPhone?: string | null },
    patient: { name: string; phone: string },
    forceNotifyStaff = false,
  ): Promise<boolean> {
    // Dedup is time-bounded (see COMPLAINT_DEDUP_WINDOW_MS). An exact
    // triggeringMessage match blocks re-logging only within the window, so a
    // patient repeating the same short phrase weeks later for a genuinely new
    // episode still gets captured.
    const existing = await this.prisma.complaint.findFirst({
      where: {
        campaignPatientId,
        triggeringMessage,
        createdAt: { gte: new Date(Date.now() - COMPLAINT_DEDUP_WINDOW_MS) },
      },
    }).catch(() => null);

    if (existing) {
      this.logger.warn(`Complaint already logged for this exact message within the last 24h — skipping duplicate`);
      return false;
    }

    // Normalize enums robustly. Local models emit lowercase, spaced, hyphenated
    // or camelCase forms; Prisma only accepts the exact enum token. If a value
    // still can't be mapped, fail loudly — the caller (tool loop) surfaces the
    // error and the model-driven classifier safety net re-attempts with a valid
    // enum, so a complaint is never silently dropped or written with wrong data.
    const type = normalizeComplaintType(input.type);
    const severity = normalizeComplaintSeverity(input.severity);

    if (!type || !severity) {
      const message =
        `log_complaint received unmappable enum(s): type=${JSON.stringify(input.type)} ` +
        `severity=${JSON.stringify(input.severity)}`;
      this.logger.error(message);
      try {
        await this.persistAudit(`audit:complaint_invalid_enum:${campaignPatientId}`, {
          ts: Date.now(), input, triggeringMessage, campaignId,
        });
      } catch { /* best-effort */ }
      throw new Error(message);
    }

    const summary = input.summary?.trim()
      ? input.summary.trim()
      : `Auto-logged complaint — Raw message: "${triggeringMessage}"`;

    try {
      await this.persistAudit(`audit:complaint_attempt:${campaignPatientId}`, {
        ts: Date.now(), input, triggeringMessage, campaignId,
      });
    } catch { /* best-effort */ }

    await this.prisma.complaint.create({
      data: {
        campaignPatientId,
        clinicId,
        type,
        severity,
        triggeringMessage,
        summary,
      },
    });

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data:  { complainedCount: { increment: 1 } },
    });

    if ((severity === ComplaintSeverity.HIGH || forceNotifyStaff) && clinic.notificationPhone) {
      try {
        const label = forceNotifyStaff ? 'PLAINTE AUTO-DÉTECTÉE (à vérifier)' : 'ALERTE PLAINTE GRAVE';
        await this.whatsappService.sendText(
          clinic.notificationPhone,
          `${label}\n` +
          `Patient : ${patient.name}\n` +
          `Téléphone : ${patient.phone}\n` +
          `Type : ${COMPLAINT_TYPE_LABELS[type]}\n` +
          `Gravité : ${COMPLAINT_SEVERITY_LABELS[severity]}\n` +
          `Résumé : ${summary}\n` +
          `Action requise.`,
        );
      } catch (err: any) {
        this.logger.error(`Failed to send complaint alert: ${err.message}`);
      }
    }

    this.logger.log(`Complaint logged successfully: ${type}/${severity} for patient ${campaignPatientId}`);
    return true;
  }

  private async executeRequestBooking(
    input: RequestBookingInput,
    campaignPatientId: string,
    clinicId: string,
    rawPatientMessage: string,
  ): Promise<void> {
    // PENDING request already exists → update it in place with the new details.
    // The patient is refining/editing their request before staff confirms it, so
    // there is no appointment yet to supersede.
    const pending = await this.prisma.bookingRequest.findFirst({
      where: { campaignPatientId, status: BookingRequestStatus.PENDING },
    });

    if (pending) {
      this.logger.log(`Updating existing pending booking request ${pending.id} for patient ${campaignPatientId} with new details.`);
      await this.prisma.bookingRequest.update({
        where: { id: pending.id },
        data: {
          preferredSpecialty: input.preferredSpecialty ?? pending.preferredSpecialty,
          preferredDoctor: input.preferredDoctor ?? pending.preferredDoctor,
          preferredDateRange: input.preferredDateRange ?? pending.preferredDateRange,
          reason: input.reason ?? pending.reason,
          rawPatientRequest: rawPatientMessage,
        },
      });
      return;
    }

    // A CONFIRMED request (with an associated appointment) already exists. The
    // patient is asking to change/reschedule. The previous implementation only
    // looked for PENDING requests, so a date change after confirmation silently
    // created a SECOND booking request while leaving the old appointment active —
    // the "old booking never superseded" bug. We must cancel the old appointment
    // (freeing the slot) and reject the old request before recording the new one.
    const confirmed = await this.prisma.bookingRequest.findFirst({
      where: { campaignPatientId, status: BookingRequestStatus.CONFIRMED },
      include: { appointment: true },
    });

    if (confirmed) {
      this.logger.log(
        `Patient ${campaignPatientId} wants to change a confirmed booking (request ${confirmed.id}) — superseding`,
      );

      if (confirmed.appointmentId && confirmed.appointment) {
        await this.prisma.appointment.update({
          where: { id: confirmed.appointmentId },
          data: {
            status: AppointmentStatus.CANCELLED,
            notes: `Superseded by new booking request on ${new Date().toISOString()}. Original reason: ${confirmed.appointment.notes ?? 'n/a'}`,
          },
        });
      }

      await this.prisma.bookingRequest.update({
        where: { id: confirmed.id },
        data: { status: BookingRequestStatus.REJECTED },
      });
    }

    await this.prisma.bookingRequest.create({
      data: {
        campaignPatientId, clinicId,
        preferredSpecialty: input.preferredSpecialty ?? null,
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
    campaignPatient: {
      id: string; campaignId: string; patientName: string; phone: string;
      visitDate: Date; prestation: string; medecinTraitant: string; ageYears: number | null; ville: string | null;
    },
    clinic: { id: string; notificationPhone?: string | null },
  ): Promise<void> {
    session.status = 'handed_off';

    const handoffReason = input.reason?.trim() || 'Patient requested to speak to a human (no reason provided).';

    await this.prisma.campaignPatient.update({
      where: { id: campaignPatient.id },
      data: { status: CampaignPatientStatus.COMPLETED, outcome: ConversationOutcome.HANDED_OFF, completedAt: new Date() },
    });

    await this.prisma.campaign.update({ where: { id: campaignPatient.campaignId }, data: { completedCount: { increment: 1 } } });

    // Normalize phone keys to avoid routing mismatches between reactive and campaign sessions
    const normalizedPhone = this.normalizePhone(session.phone);
    session.phone = normalizedPhone;
    // Persist the handed_off campaign session so staff can see incoming messages
    // (message.processor routes them here via isHandoffCampaignSession). It must
    // NOT be deleted afterwards — that was the previous bug that caused handed-off
    // conversations to "leak" back into the reactive booking bot.
    await this.sessionsService.saveCampaignSession(session);
    // Only the stale reactive session is removed: it must not shadow the campaign
    // handoff session for the same phone number.
    await this.sessionsService.delete(normalizedPhone).catch(() => {});

    await this.handoffService.createHandoff({
      clinicId: clinic.id,
      source: BookingSource.CAMPAIGN,
      phone: normalizedPhone,
      patientName: campaignPatient.patientName,
      campaignPatientId: campaignPatient.id,
      reason: handoffReason,
      language: session.language,
      ageYears: campaignPatient.ageYears,
      ville: campaignPatient.ville,
      visitDate: campaignPatient.visitDate,
      prestation: campaignPatient.prestation,
      medecinTraitant: campaignPatient.medecinTraitant,
    });

    this.logger.log(`Handoff executed for patient ${campaignPatient.id} — session kept alive for staff`);
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
      data: { status: CampaignPatientStatus.COMPLETED, outcome, completedAt: new Date() },
    });

    await this.prisma.campaign.update({ where: { id: campaignId }, data: { completedCount: { increment: 1 } } });

    await this.sessionsService.deleteCampaignSession(session.phone);
    await this.sessionsService.delete(session.phone);

    this.logger.log(`Conversation closed for patient ${campaignPatientId} — outcome: ${outcome}`);
  }

  /**
   * PRODUCTION GUARDRAIL: Sanitizes the AI response before it ever reaches WhatsApp.
   */
  private sanitizeTextReply(raw: string, phone: string, hadToolUseBlocks: boolean, language: Language | null): string {
    if (!raw) return raw;

    // 1. Check for tool leak patterns — broadened set, see TOOL_LEAK_PATTERNS above.
    if (TOOL_LEAK_PATTERNS.some(pattern => pattern.test(raw))) {
      this.logger.error(`TOOL-CALL LEAK detected in text reply for ${phone}. Raw text: ${raw}`);
      // PRODUCTION FIX: previously returned '' (empty string), meaning the
      // patient silently received NOTHING for that turn if the only content
      // was a leaked tool call. Now returns a safe, language-appropriate
      // fallback so the patient always gets a human response.
      return language === Language.EN
        ? "Thank you for your message. I've noted it and our team will follow up if needed."
        : "Merci pour votre message. Je l'ai bien noté et notre équipe vous recontactera si nécessaire.";
    }

    // 2. Medical Advice Guardrail
    const medicalAdvicePatterns = [
      /you should take/i, /you might have/i, /it sounds like/i, /you need to take/i,
      /take\s\d+\s?(mg|ml|pill|tablet)/i, /vous devriez prendre/i, /il semble que vous ayez/i,
      /vous avez besoin de/i, /prenez\s\d+\s?(mg|ml|comprimé)/i, /diagnosis/i, /diagnostic/i
    ];

    if (medicalAdvicePatterns.some(pattern => pattern.test(raw))) {
      this.logger.error(`MEDICAL ADVICE LEAK detected for ${phone}. Raw text: ${raw}`);
      return language === Language.EN
        ? "I'm not able to provide medical advice, but I have logged your concern for the clinical team to review immediately."
        : "Je ne peux pas donner de conseils médicaux, mais j'ai enregistré votre préoccupation pour que l'équipe clinique l'examine immédiatement.";
    }

    // 3. Strip any residual JSON or code-like structures
    let sanitized = raw.replace(/\{[^{}]*\}/g, '');
    sanitized = sanitized.replace(/\[[^\[\]]*\]/g, '');

    // 4. Strip any residual "think" tags or artifacts just in case they slipped through the provider
    sanitized = sanitized.replace(/<think>[\s\S]*?<\/think>/gi, '');
    sanitized = sanitized.replace(/<think>/gi, ''); // unclosed think tags
    sanitized = sanitized.replace(/<\|[^|]*\|>/gi, ''); // strip <|im_start|> artifacts

    // 5. Clean up extra spaces/newlines left behind by stripping
    sanitized = sanitized.replace(/\s{2,}/g, ' ').replace(/\n{2,}/g, '\n').trim();

    return sanitized;
  }

  private async persistAudit(key: string, payload: any): Promise<void> {
    try {
      const redis = this.sessionsService.getClient();
      await redis.lpush(key, JSON.stringify(payload));
      // Keep last 1000 entries to bound memory
      await redis.ltrim(key, 0, 999);
    } catch (err: any) {
      this.logger.error(`Failed to persist audit ${key}: ${err.message}`);
    }
  }

  private normalizePhone(phone: string): string {
    if (!phone) return phone;
    // Basic normalization: strip leading '+', spaces, and surrounding whitespace.
    return phone.replace(/^\+/, '').trim();
  }

  private detectLanguage(message: string): Language | null {
    const lower = message.toLowerCase().trim();

    // Explicit language switches
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

    // Strong, unambiguous language signals (checked before word scoring). These
    // catch common English phrases the keyword scorer misses — e.g. "i wanna
    // rebook" scores 0 on both sides because "rebook"/"wanna" aren't in the word
    // lists and "book" fails the word-boundary test inside "rebook".
    const strongEn = [
      'i wanna', 'i want', 'i need', 'i said', 'i would', 'i will', 'i have', 'i am',
      "i'm", 'can i', 'could i', 'do you', 'are you', 'what the', 'as soon as possible',
      'thank you', 'wtf', 'wanna', 'gonna', 'rebook', 'asap', 'i don',
    ];
    const strongFr = [
      'je veux', 'je suis', 'je voudrais', "c'est quoi", "qu'est-ce", 'quest ce',
      'svp', "s'il vous plaît", 's il vous plait', 'rendez-vous', 'rendez vous', 'rdv',
      'merci beaucoup', 'pourquoi', 'comment ça va', 'comment ca va',
    ];

    if (strongEn.some(p => lower.includes(p))) return Language.EN;
    if (strongFr.some(p => lower.includes(p))) return Language.FR;

    if (lower.length < 3) return null;

    // Common short responses to instantly lock language
    const frShort = ['salut', 'bonjour', 'bonsoir', 'oui', 'non', 'merci', 'ça va', 'ca va', 'bien', 'mal', 'ok', 'd\'accord', 'super', 'grande'];
    const enShort = ['hi', 'hello', 'hey', 'yes', 'no', 'yeah', 'thanks', 'thank you', 'fine', 'good', 'bad', 'ok', 'okay', 'sure', 'great'];

    // If message is very short, rely on exact matches to switch language instantly
    if (lower.split(/\s+/).length <= 3) {
      if (frShort.some(w => lower === w || lower.includes(w))) return Language.FR;
      if (enShort.some(w => lower === w || lower.includes(w))) return Language.EN;
    }

    // Extended arrays for longer message scoring
    const frWords = [
      ...frShort, 'comment', 'pour', 'avec', 'dans', 'vous', 'nous', 'est-ce', "j'ai", "c'est", 'pas', 'je',
      'quoi', 'rien', 'tout', 'encore', 'maintenant', 'vraiment', 'rendez-vous', 'rendez vous', 'semaine', 'prochaine', 'prochain',
      'douleur', 'après-midi', 'apres-midi', 'matin', 'docteur', 'médecin', 'medecin', 'hopital', 'urgent', 'prendre', 'aller',
    ];
    const enWords = [
      ...enShort, 'what', 'when', 'where', 'how', "i'm", 'i am', 'i have', 'i need',
      'done', 'right', 'got it', 'appointment', 'book', 'booking', 'week', 'next', 'pain', 'hurt',
      'afternoon', 'morning', 'again', 'actually', 'doctor', 'hospital', 'need', 'go', 'please',
      'give', 'want', 'human', 'talk', 'hear', 'said', 'with', 'about', 'the', 'my', 'your',
      'now', 'before', 'good', 'was', 'not', 'details', 'visit',
    ];

    const wb = (word: string) =>
      new RegExp(`(?<![a-zàâçéèêëîïôûùüÿæœ])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-zàâçéèêëîïôûùüÿæœ])`, 'i');

    const frScore = frWords.filter(w => wb(w).test(lower)).length;
    const enScore = enWords.filter(w => wb(w).test(lower)).length;

    if (enScore > frScore) return Language.EN;
    if (frScore > enScore) return Language.FR;

    return null;
  }

  async fetchBotMessage(
    clinicId: string,
    key: MessageKey,
    language: Language,
    variables?: Record<string, string>,
  ): Promise<string | null> {
    const record = await this.prisma.botMessage.findUnique({ where: { clinicId_key_language: { clinicId, key, language } } });

    let body = record?.body ?? null;

    if (!body && language !== Language.FR) {
      const fallback = await this.prisma.botMessage.findUnique({ where: { clinicId_key_language: { clinicId, key, language: Language.FR } } });
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