import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService, CampaignSession, CampaignMessage } from '../sessions/sessions.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { OllamaProvider } from './providers/ollama.provider';
import { AIMessage, AIInputMessage, AIToolDefinition, AITextBlock, AIToolUseBlock } from './providers/ai-response.types';
import {
  CampaignPatientStatus,
  ComplaintSeverity,
  ComplaintType,
  ConversationOutcome,
  Language,
  MessageKey,
  BookingRequestStatus,
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

const SYMPTOM_URGENCY_KEYWORDS = [
  'mal', 'douleur', 'fièvre', 'fievre', 'saign', 'vertige', 'nausée', 'nausee',
  'vomi', 'gonfl', 'infection', 'urgence', 'urgent', 'grave', 'hôpital', 'hopital',
  'malade', 'souffre', 'souffrance', 'aggrav', 'empire',
  'plainte', 'insatisf', 'déçu', 'decu', 'mécontent', 'mecontent', 'nul',
  'honteux', 'inacceptable', 'scandaleux', 'jamais revenir',
  // Additional complaint/abuse indicators (catch colloquial English insults and threats)
  'shit', 'crazy', 'abuse', 'assault', 'hit', 'attack', 'threat',
  'pain', 'hurt', 'fever', 'bleed', 'dizzy', 'nausea', 'vomit', 'swelling',
  'infection', 'emergency', 'urgent', 'serious', 'hospital', 'sick', 'worse', 'worsen',
  'complaint', 'complain', 'disappointed', 'unhappy', 'terrible', 'awful',
  'unacceptable', 'ridiculous', 'never come back', 'never coming back',
];

function containsSymptomOrUrgencySignal(message: string): boolean {
  const lower = message.toLowerCase();
  return SYMPTOM_URGENCY_KEYWORDS.some(kw => lower.includes(kw));
}

// PRODUCTION FIX: dedup window for complaint logging. Previously an exact
// triggeringMessage match blocked re-logging FOREVER — a patient repeating
// the same short phrase ("j'ai mal à la tête") weeks later for a genuinely
// new or worsening episode would silently never get logged again. 24h is
// long enough to absorb a model retry/double-fire within one conversation,
// short enough that a later real recurrence still gets captured.
const COMPLAINT_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionsService: SessionsService,
    private readonly whatsappService: WhatsAppService,
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

      for (const toolBlock of toolUseBlocks) {
        this.logger.log(`Tool: ${toolBlock.name} — ${JSON.stringify(toolBlock.input)}`);

        let resultContent = 'Success';
        try {
          if (toolBlock.name === 'log_complaint') {
            const input = toolBlock.input as unknown as LogComplaintInput;
            const wasLogged = await this.executeLogComplaint(
              input, campaignPatient.id, clinic.id, patientMessage, campaignPatient.campaignId, clinic,
            );
            resultContent = 'Complaint logged successfully.';
            if (wasLogged) complaintLoggedThisTurn = true;

            const severityStr = String(input.severity).toUpperCase();
            if (severityStr === ComplaintSeverity.HIGH) highSeverityComplaintLogged = true;

          } else if (toolBlock.name === 'request_booking') {
            await this.executeRequestBooking(
              toolBlock.input as unknown as RequestBookingInput, campaignPatient.id, clinic.id, patientMessage,
            );
            resultContent = 'Booking request recorded.';

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

    // ── Model-driven complaint detection safety net (preferred) ───────────
    // If the AI did not call log_complaint during its turn, ask the model
    // itself (via a constrained "classify_complaint" tool) whether the
    // patient's message should be logged. This avoids brittle keyword rules.
    if (!complaintLoggedThisTurn) {
      let classification = null;
      try {
        classification = await this.classifyComplaintWithModel(patientMessage, session.language ?? Language.FR, phone);
      } catch (err: any) {
        // Enterprise-grade: do NOT fall back to brittle keyword rules. Instead
        // persist an audit entry and alert staff for manual review.
        this.logger.error(`Complaint classifier failed for ${phone}: ${err.message} — manual review required`);
        try {
          await this.persistAudit(`audit:classifier:${phone}`, { ts: Date.now(), error: String(err), message: patientMessage });
        } catch { /* best-effort */ }

        if (clinic.notificationPhone) {
          try {
            await this.whatsappService.sendText(
              clinic.notificationPhone,
              `Classifier failure for patient ${campaignPatient.id} (${phone}). Manual review required. Message: "${patientMessage}"`,
            );
          } catch (err2: any) {
            this.logger.error(`Failed to notify staff of classifier failure for ${phone}: ${err2.message}`);
          }
        }
      }

      if (classification && classification.is_complaint) {
        this.logger.warn(
          `Model classification flagged message from ${phone} as complaint (type=${classification.type}, severity=${classification.severity}) — logging`,
        );
        try {
          await this.executeLogComplaint(
            {
              type: classification.type ?? ComplaintType.MEDICAL_CONCERN,
              severity: classification.severity ?? ComplaintSeverity.MEDIUM,
              summary: classification.summary ?? `Auto-flagged by model classifier — Raw message: "${patientMessage}"`,
            },
            campaignPatient.id, clinic.id, patientMessage, campaignPatient.campaignId, clinic, true,
          );
        } catch (err: any) {
          this.logger.error(`Model-driven complaint logging failed for ${phone}: ${err.message}`);
        }
      }
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

FORMATTING RULES:
- Never use emojis.
- Keep every message to 2-4 sentences maximum. This is WhatsApp, not email.
- Never ask more than one question per message.
- Never invent medical advice or diagnoses.
- Never mention other patients.
- DO NOT use time-specific greetings like "Bonjour" (morning), "Bonsoir" (evening), "Good morning", "Good evening". Use time-neutral greetings like "Salut" (French) or "Hello" (English).

STRICT MEDICAL GUARDRAIL:
- You are NOT a doctor. You must NEVER diagnose, suggest treatments, or ask medical triage questions (e.g., "does it come with fever?", "how long has this lasted?", "where exactly does it hurt?", "how did it happen?").
- If a patient mentions a symptom, pain, or health issue, immediately call log_complaint and respond with empathy ONLY — do not ask about the symptom, its cause, its location, or its duration.
- DO NOT offer medical advice or attempt to triage the patient.

EXAMPLE — follow this pattern exactly:
Patient: "j'ai mal à la tête depuis hier"
Correct tool call: log_complaint(type=MEDICAL_CONCERN, severity=MEDIUM, summary="Patient reports headache since yesterday")
Correct reply: "Je suis désolé d'apprendre que vous avez mal à la tête. J'ai bien noté votre message, notre équipe va vous recontacter si nécessaire."
Incorrect reply (NEVER do this): "Pourriez-vous me dire où précisément vous ressentez cette douleur ?" or "Comment est-ce arrivé ?"

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
   - This includes ANY mention of a symptom, pain, or health issue — even something that sounds minor (e.g. "j'ai mal à la tête", "I have a headache", "je me sens fatigué"). Do NOT wait for the patient to elaborate or ask them clinical questions first — log it immediately with whatever detail they gave you.
   - You are NOT a doctor and must NEVER ask clinical/triage questions. Simply acknowledge warmly, log the concern via this tool, and let the clinic follow up properly.
   - This is a SILENT side effect. After calling it, you MUST send a warm, empathetic text response to the patient acknowledging their concern. Do NOT tell the patient you "logged" anything, and do NOT ask them to describe their symptoms further.
   - IDEMPOTENCY: Only call this once per distinct issue. If you already called it for this issue and received a success response, do NOT call it again.

2. request_booking
   - Call this when the patient wants to book a new appointment.
   - BEFORE calling this tool, you MUST collect ALL of the following through conversation:
     a) REASON — why do they need the appointment? Ask if not mentioned.
     b) PREFERRED DATE — when do they want to come? Ask if not mentioned. Accept any format ("next week", "le 5 juillet", etc.)
     c) PREFERRED DOCTOR OR SPECIALTY — do they have a preference? Ask if not mentioned. Accept "no preference" as a valid answer.
   - Ask for each missing piece ONE AT A TIME — one question per message. Never ask two things at once.
   - Only call request_booking once ALL THREE are known (doctor/specialty can be "no preference").
   - This is a SILENT side effect. After calling it, confirm warmly in text that their request has been noted and the team will contact them to confirm the exact appointment.
   - IDEMPOTENCY: Only call this once per booking request. Do not call it again if already called.

3. request_handoff
   - Call this when the patient explicitly asks for a human, is very distressed, or the situation is HIGH severity.
   - IMPORTANT: If the patient also complained, call log_complaint FIRST, then request_handoff, in the SAME turn.
   - PRIORITY RULE: If the patient explicitly asks to speak to a human/staff member, OR uses words like
     "maintenant", "urgent", "immédiatement", "right now", "immediately" together with a health concern,
     you MUST call request_handoff. NEVER call log_complaint alone when the patient has explicitly requested a human.
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

If the patient's message is unclear, a typo, or ambiguous (random characters, incomplete words, something you don't understand), do NOT interpret it as a goodbye, complaint, or any specific intent. Simply ask them to clarify what they meant.

NEVER write a tool's name or its arguments as visible text to the patient. Tool calls happen silently and separately from your text reply — the patient must only ever see natural conversational language, never anything resembling code, JSON, or a function name.
If you decide to call a tool, output ONLY the tool call — do not also describe it, name it, or paraphrase its arguments in your text response.

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
   * deterministic keyword safety net still needs to fire.
   */
  private async executeLogComplaint(
    input: LogComplaintInput,
    campaignPatientId: string,
    clinicId: string,
    triggeringMessage: string,
    campaignId: string,
    clinic: { id: string; notificationPhone?: string | null },
    forceNotifyStaff = false,
  ): Promise<boolean> {
    // PRODUCTION FIX: dedup is now time-bounded (see COMPLAINT_DEDUP_WINDOW_MS).
    // Previously an exact triggeringMessage match blocked re-logging forever,
    // meaning a patient repeating the same short phrase weeks later for a
    // genuinely new episode would never get logged.
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

    // PRODUCTION FIX: Local models often return lowercase enums (e.g. "complaint").
    // Prisma strictly rejects these. We MUST sanitize to uppercase.
    const typeStr = String(input.type).toUpperCase() as ComplaintType;
    const severityStr = String(input.severity).toUpperCase() as ComplaintSeverity;

    try {
      // Persist an audit of the attempted complaint creation for observability
      try { await this.persistAudit(`audit:complaint_attempt:${campaignPatientId}`, { ts: Date.now(), input, triggeringMessage, campaignId }); } catch {}

      await this.prisma.complaint.create({
        data: { 
          campaignPatientId, 
          clinicId, 
          type: typeStr, 
          severity: severityStr, 
          triggeringMessage, 
          summary: input.summary 
        },
      });

      await this.prisma.campaign.update({ 
        where: { id: campaignId }, 
        data: { complainedCount: { increment: 1 } } 
      });

      if ((severityStr === ComplaintSeverity.HIGH || forceNotifyStaff) && clinic.notificationPhone) {
        try {
          const label = forceNotifyStaff ? 'PLAINTE AUTO-DÉTECTÉE (à vérifier)' : 'ALERTE PLAINTE GRAVE';
          await this.whatsappService.sendText(
            clinic.notificationPhone,
            `${label}\nPatient: ${campaignPatientId}\nType: ${typeStr}\nRésumé: ${input.summary}\nAction requise.`,
          );
        } catch (err: any) {
          this.logger.error(`Failed to send complaint alert: ${err.message}`);
        }
      }

      this.logger.log(`Complaint logged successfully: ${typeStr}/${severityStr} for patient ${campaignPatientId}`);
      return true;
    } catch (err: any) {
      // PRODUCTION FIX: Log the exact Prisma error and attempt a safe fallback
      this.logger.error(`DATABASE ERROR saving complaint (primary): ${err.message}`);
      try {
        await this.persistAudit(`audit:complaint_error:${campaignPatientId}`, { ts: Date.now(), error: String(err), input, triggeringMessage, campaignId });
      } catch {}

      // Attempt safe fallback: create a minimal complaint record so nothing is lost
      try {
        const fallbackSummary = input.summary ?? `Auto-flagged fallback entry — Raw message: "${triggeringMessage}"`;
        await this.prisma.complaint.create({
          data: {
            campaignPatientId,
            clinicId,
            type: ComplaintType.MEDICAL_CONCERN,
            severity: ComplaintSeverity.MEDIUM,
            triggeringMessage,
            summary: fallbackSummary,
          },
        });

        // Still try to increment campaign complainedCount
        try { await this.prisma.campaign.update({ where: { id: campaignId }, data: { complainedCount: { increment: 1 } } }); } catch {}

        // Notify staff that a fallback complaint was created due to DB issues
        if (clinic.notificationPhone) {
          try {
            await this.whatsappService.sendText(
              clinic.notificationPhone,
              `Fallback complaint created for patient ${campaignPatientId} due to DB error. Please review. Message: "${triggeringMessage}"`,
            );
          } catch (err2: any) {
            this.logger.error(`Failed to notify staff of fallback complaint for ${campaignPatientId}: ${err2.message}`);
          }
        }

        this.logger.log(`Fallback complaint logged for patient ${campaignPatientId}`);
        return true;
      } catch (fallbackErr: any) {
        this.logger.error(`Fallback complaint creation failed: ${fallbackErr.message}`);
        try { await this.persistAudit(`audit:complaint_error:${campaignPatientId}`, { ts: Date.now(), fallbackError: String(fallbackErr) }); } catch {}

        // As final recourse, notify staff for manual action
        if (clinic.notificationPhone) {
          try {
            await this.whatsappService.sendText(
              clinic.notificationPhone,
              `CRITICAL: Failed to create complaint for patient ${campaignPatientId}. Manual action required. Message: "${triggeringMessage}"`,
            );
          } catch (err3: any) {
            this.logger.error(`Failed to notify staff of critical complaint failure: ${err3.message}`);
          }
        }

        return false;
      }
    }
  }

  private async executeRequestBooking(
    input: RequestBookingInput,
    campaignPatientId: string,
    clinicId: string,
    rawPatientMessage: string,
  ): Promise<void> {
    const existing = await this.prisma.bookingRequest.findFirst({
      where: { campaignPatientId, status: BookingRequestStatus.PENDING },
    });

    if (existing) {
      this.logger.log(`Updating existing pending booking request ${existing.id} for patient ${campaignPatientId} with new details.`);

      // PRODUCTION FIX: Update the existing request instead of skipping.
      await this.prisma.bookingRequest.update({
        where: { id: existing.id },
        data: {
          preferredSpecialty: input.preferredSpecialty ?? existing.preferredSpecialty,
          preferredDoctor: input.preferredDoctor ?? existing.preferredDoctor,
          preferredDateRange: input.preferredDateRange ?? existing.preferredDateRange,
          reason: input.reason ?? existing.reason,
          rawPatientRequest: rawPatientMessage,
        },
      });
      return;
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

    await this.prisma.campaignPatient.update({
      where: { id: campaignPatient.id },
      data: { status: CampaignPatientStatus.COMPLETED, outcome: ConversationOutcome.HANDED_OFF, completedAt: new Date() },
    });

    await this.prisma.campaign.update({ where: { id: campaignPatient.campaignId }, data: { completedCount: { increment: 1 } } });

    // Normalize phone keys to avoid routing mismatches between reactive and campaign sessions
    const normalizedPhone = this.normalizePhone(session.phone);
    session.phone = normalizedPhone;
    await this.sessionsService.saveCampaignSession(session);
    // Remove reactive session if present and ensure campaign key is saved
    await this.sessionsService.deleteCampaignSession(normalizedPhone).catch(() => {});
    await this.sessionsService.delete(normalizedPhone).catch(() => {});

    if (clinic.notificationPhone) {
      try {
        const visitDate = new Date(campaignPatient.visitDate).toLocaleDateString('fr-FR');
        const now = new Date().toLocaleString('fr-MA', { timeZone: 'Africa/Casablanca' });

        const notification =
          `PATIENT HANDOFF REQUIRED\n---------------------------\n` +
          `Name      : ${campaignPatient.patientName}\n` +
          `Phone     : ${campaignPatient.phone}\n` +
          `Age       : ${campaignPatient.ageYears ?? 'N/A'} years\n` +
          `City      : ${campaignPatient.ville ?? 'N/A'}\n---------------------------\n` +
          `Last visit   : ${visitDate}\n` +
          `Visit reason : ${campaignPatient.prestation}\n` +
          `Doctor       : ${campaignPatient.medecinTraitant}\n---------------------------\n` +
          `Handoff reason : ${input.reason}\n---------------------------\n` +
          `Time : ${now}\nAction required : Contact this patient immediately.`;

        await this.whatsappService.sendText(clinic.notificationPhone, notification);
      } catch (err: any) {
        this.logger.error(`Failed to notify staff of handoff: ${err.message}`);
      }
    }

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

  /**
   * Model-driven classifier: asks the Ollama model to call a constrained
   * "classify_complaint" tool with { is_complaint, type, severity, summary }.
   * The OllamaProvider will convert that into a tool_use block which is
   * then returned here as a parsed object. This avoids brittle keyword
   * lists and makes the decision model-driven.
   */
  private async classifyComplaintWithModel(message: string, language: Language | null, phone: string): Promise<{is_complaint: boolean; type?: ComplaintType; severity?: ComplaintSeverity; summary?: string} | null> {
    const classifyTool: AIToolDefinition = {
      name: 'classify_complaint',
      description: 'Internal classifier: decide whether a user message constitutes a complaint/medical concern/urgent case.',
      input_schema: {
        type: 'object',
        properties: {
          is_complaint: { type: 'boolean' },
          type: { type: 'string', enum: ['COMPLAINT', 'MEDICAL_CONCERN', 'URGENT'] },
          severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
          summary: { type: 'string' },
        },
        required: ['is_complaint'],
      },
    };

    const systemPrompt = `You are a strict classifier that decides whether a patient's message requires the clinic to log a complaint or medical concern. You MUST output ONLY a tool call to classify_complaint with input { is_complaint: boolean, type: one of COMPLAINT|MEDICAL_CONCERN|URGENT, severity: LOW|MEDIUM|HIGH, summary: short summary }. Do NOT output any visible text to the patient. Be conservative: prefer to flag when unsure.`;

    const messages: AIInputMessage[] = [ { role: 'user', content: message } ];

    // Retry loop for robustness (enterprise-grade): a few fast retries with backoff
    const maxAttempts = 3;
    const backoffs = [200, 500, 1000];
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this.ollamaProvider.generate(systemPrompt, messages, [classifyTool]);
        const toolUseBlocks = response.content.filter((b): b is AIToolUseBlock => b.type === 'tool_use');
        if (!toolUseBlocks || toolUseBlocks.length === 0) {
          // Persist audit that classifier returned no tool use
          await this.persistAudit(`audit:classifier:${phone}`, { ts: Date.now(), note: 'no_tool_use', response: response.content });
          return null;
        }

        const classificationInput = toolUseBlocks[0].input as any;
        const result = {
          is_complaint: Boolean(classificationInput.is_complaint),
          type: classificationInput.type as ComplaintType | undefined,
          severity: classificationInput.severity as ComplaintSeverity | undefined,
          summary: typeof classificationInput.summary === 'string' ? classificationInput.summary : undefined,
        };

        // Persist an audit entry of the classifier decision for observability
        try {
          await this.persistAudit(`audit:classifier:${phone}`, { ts: Date.now(), input: classificationInput, result });
        } catch { /* best-effort */ }

        return result;
      } catch (err: any) {
        lastErr = err;
        this.logger.warn(`Classifier attempt ${attempt} failed for ${phone}: ${err.message}`);
        if (attempt < maxAttempts) {
          const waitMs = backoffs[Math.min(attempt - 1, backoffs.length - 1)];
          await new Promise(res => setTimeout(res, waitMs));
          continue;
        }
      }
    }

    // If we reached here, all attempts failed — throw an error to be handled by caller
    throw lastErr ?? new Error('Unknown classifier failure');
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