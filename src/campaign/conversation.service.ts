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
  type: 'text';
  text: string;
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

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

// ─── Claude tool definitions ──────────────────────────────────────────────────

const CLAUDE_TOOLS = [
  {
    name: 'log_complaint',
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
          description: 'A clear 1-2 sentence summary of the complaint written in the exact same language the patient used to express it (e.g. Arabic, French, or English).',
        },
      },
      required: ['type', 'severity', 'summary'],
    },
  },
  {
    name: 'request_booking',
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
    name: 'request_handoff',
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
    name: 'end_conversation',
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

const ANTHROPIC_MODEL = 'claude-haiku-4-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const MAX_RETRIES = 2;
const RETRY_DELAY = 1500;

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);
  private readonly anthropicApiKey: string | undefined;
  private readonly isEnabled: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
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
  // PUBLIC ENTRY POINT
  // ═══════════════════════════════════════════════════════════════════════════

  async handleReply(phone: string, patientMessage: string): Promise<void> {
    this.logger.log(`Campaign reply from ${phone}: "${patientMessage}"`);

    const session = await this.sessionsService.getCampaignSession(phone);
    if (!session) {
      this.logger.error(`No campaign session found for ${phone} — cannot handle reply`);
      return;
    }

    if (session.status === 'completed' || session.status === 'handed_off' || session.status === 'admin_handling') {
      this.logger.warn(`Campaign session for ${phone} is ${session.status} — ignoring reply`);
      return;
    }

    const campaignPatient = await this.prisma.campaignPatient.findUnique({
      where: { id: session.campaignPatientId },
      include: { campaign: true },
    });

    if (!campaignPatient) {
      this.logger.error(`CampaignPatient ${session.campaignPatientId} not found for phone ${phone}`);
      return;
    }

    const clinic = await this.prisma.clinic.findUnique({
      where: { id: session.clinicId },
    });

    if (!clinic) {
      this.logger.error(`Clinic ${session.clinicId} not found`);
      return;
    }

    // FIX: Dynamic language evaluation per turn if user switches from greeting (e.g. French "Bonjour" to Arabic body text)
    const detected = this.detectLanguage(patientMessage);
    if (session.language !== detected) {
      session.language = detected;
      await this.prisma.campaignPatient.update({
        where: { id: campaignPatient.id },
        data: { language: detected },
      });
      this.logger.log(`Language dynamically updated/set for ${phone}: ${detected}`);
    }

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

    const alreadyPresent = session.messages.some(
      m => m.role === 'user' && m.content === patientMessage && Date.now() - m.timestamp < 5000,
    );

    if (!alreadyPresent) {
      session.messages.push({
        role: 'user',
        content: patientMessage,
        timestamp: Date.now(),
      });
    }

    let aiMaxTurns = (session as any).cachedAiMaxTurns as number | undefined;
    if (!aiMaxTurns) {
      aiMaxTurns = clinic.aiMaxTurns;
      const campaign = campaignPatient.campaign;
      if (campaign && campaign.aiMaxTurns !== null && campaign.aiMaxTurns !== undefined) {
        aiMaxTurns = campaign.aiMaxTurns;
      }
      (session as any).cachedAiMaxTurns = aiMaxTurns;
    }

    if (session.turnCount >= aiMaxTurns) {
      this.logger.warn(`Turn limit (${aiMaxTurns}) reached for ${phone} — sending farewell and closing`);

      // FIX: Changed from CAMPAIGN_URGENT_MESSAGE to fallback generic or closure template safely
      const farewell = await this.fetchBotMessage(
        clinic.id,
        MessageKey.CAMPAIGN_FAREWELL_MESSAGE,
        session.language ?? Language.FR,
      );
      if (farewell) await this.whatsappService.sendText(phone, farewell);
      await this.closeConversation(session, campaignPatient.id, campaignPatient.campaignId, ConversationOutcome.COMPLETED);
      return;
    }

    const systemPrompt = this.buildSystemPrompt(session, campaignPatient, clinic);
    const claudeMessages = this.buildClaudeMessages(session);

    let loopCount = 0;
    const maxLoops = 5;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let conversationEnded = false;

    while (loopCount < maxLoops && !conversationEnded) {
      let response: AnthropicMessage;
      try {
        response = await this.callClaudeWithRetry(systemPrompt, claudeMessages);
      } catch (err: any) {
        this.logger.error(`Claude call failed after retries for ${phone}: ${err.message}`);
        const errorMsg = session.language === Language.EN
          ? 'Sorry, I encountered a technical issue. Please try again in a few minutes.'
          : 'Désolé, je rencontre un problème technique. Veuillez réessayer dans quelques minutes.';
        await this.whatsappService.sendText(phone, errorMsg);
        return;
      }

      if (response.usage) {
        totalInputTokens += response.usage.input_tokens;
        totalOutputTokens += response.usage.output_tokens;
      }

      claudeMessages.push({ role: 'assistant', content: response.content as any });
      session.messages.push({
        role: 'assistant',
        content: JSON.stringify(response.content),
        timestamp: Date.now(),
      });

      if (response.stop_reason === 'tool_use' || response.content.some(b => b.type === 'tool_use')) {
        const toolResultsContent = [];

        for (const block of response.content) {
          if (block.type === 'tool_use') {
            const toolBlock = block as AnthropicToolUseBlock;
            this.logger.log(`Executing tool: ${toolBlock.name} — input: ${JSON.stringify(toolBlock.input)}`);

            let resultString = 'Success';
            try {
              if (toolBlock.name === 'log_complaint') {
                await this.executeLogComplaint(toolBlock.input as any, campaignPatient.id, clinic.id, patientMessage, campaignPatient.campaignId, clinic);
                resultString = 'Complaint logged successfully.';
              } else if (toolBlock.name === 'request_booking') {
                await this.executeRequestBooking(toolBlock.input as any, campaignPatient.id, clinic.id, patientMessage);
                resultString = 'Booking request recorded successfully.';
              } else if (toolBlock.name === 'request_handoff') {
                await this.executeRequestHandoff(toolBlock.input as any, session, campaignPatient.id, campaignPatient.campaignId, clinic);
                resultString = 'Handoff executed. Do not reply to the user anymore.';
                conversationEnded = true;
              } else if (toolBlock.name === 'end_conversation') {
                await this.closeConversation(session, campaignPatient.id, campaignPatient.campaignId, (toolBlock.input as any).outcome);
                resultString = 'Conversation closed. Do not reply to the user anymore.';
                conversationEnded = true;
              }
            } catch (err: any) {
              this.logger.error(`Tool ${toolBlock.name} execution failed: ${err.message}`);
              resultString = `Error executing tool: ${err.message}`;
            }

            toolResultsContent.push({
              type: 'tool_result',
              tool_use_id: toolBlock.id,
              content: resultString,
            });
          }
        }

        claudeMessages.push({ role: 'user', content: toolResultsContent as any });
        session.messages.push({
          role: 'user',
          content: JSON.stringify(toolResultsContent),
          timestamp: Date.now(),
        });

        if (conversationEnded) break;

        loopCount++;
        continue;
      }

      const finalResponseText = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as AnthropicTextBlock).text)
        .join('\n\n')
        .trim();

      if (finalResponseText) {
        await this.whatsappService.sendText(phone, finalResponseText);
      }
      break;
    }

    session.turnCount += 1;

    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      try {
        if ('aiUsage' in this.prisma) {
          await (this.prisma as any).aiUsage.create({
            data: {
              campaignPatientId: campaignPatient.id,
              clinicId: clinic.id,
              campaignId: campaignPatient.campaignId,
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              model: ANTHROPIC_MODEL,
            },
          });
        }
      } catch (e: any) {
        this.logger.warn(`Failed to log token usage: ${e.message}`);
      }
    }

    await this.prisma.campaignPatient.update({
      where: { id: campaignPatient.id },
      data: {
        messages: session.messages as any,
        turnCount: session.turnCount,
      },
    });

    if (!conversationEnded) {
      await this.sessionsService.saveCampaignSession(session);
    }

    this.logger.log(`Turn ${session.turnCount}/${aiMaxTurns} complete for ${phone}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SYSTEM PROMPT BUILDER
  // ═══════════════════════════════════════════════════════════════════════════

  private buildSystemPrompt(
    session: CampaignSession,
    campaignPatient: { patientSnapshot: any; patientName: string; visitDate: Date; prestation: string; medecinTraitant: string; ageYears: number | null; sexe: string | null; ville: string | null },
    clinic: { name: string; phone: string; address?: string | null; openingHours?: string | null },
  ): string {
    const snapshot = campaignPatient.patientSnapshot as Record<string, any>;
    const historyData = snapshot?.history ?? null;
    const language = session.language ?? Language.FR;

    // FIX: Optimized explicit instructions ensuring tool parameters mirror the conversation's active tongue
    const languageInstruction = language === Language.EN
      ? 'Always respond in English. Ensure your log_complaint text summaries are written cleanly in English.'
      : language === Language.AR
        ? 'Respond natively in Moroccan Darija (using Arabic script). Use simple, clear, and direct phrasing. Ensure the log_complaint tool summaries are rendered in clear Arabic matching the context.'
        : 'Always respond in French. Use polite, professional "vous" form. Ensure tool summaries are saved in French.';

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
    const today = new Date().toISOString().split('T')[0];

    const clinicInfoParts: string[] = [];
    if (clinic.phone) clinicInfoParts.push(`Clinic phone: ${clinic.phone}`);
    if (clinic.address) clinicInfoParts.push(`Clinic address: ${clinic.address}`);
    if (clinic.openingHours) clinicInfoParts.push(`Clinic hours: ${clinic.openingHours}`);
    const clinicInfoSection = clinicInfoParts.length > 0
      ? `CLINIC INFO:\n${clinicInfoParts.join('\n')}\n`
      : '';

    return `You are a compassionate, professional medical follow-up assistant for ${clinic.name}.

${languageInstruction}

CURRENT DATE: ${today}

CRITICAL: Always use ${today} as your reference for "today" when calculating relative dates (tomorrow, next week, etc.).

CRITICAL FORMATTING RULE:
- NEVER use any emojis (e.g., 😊, 🩺, ⚠️, 🚫) under any circumstances. Emojis are strictly forbidden. Maintain a clean, plain text, highly mature, and professional clinical persona.

CRITICAL TOOL-CALLING RULES (IDEMPOTENCY):
- Look closely at the conversation history below. If you have already invoked a tool (like 'log_complaint' or 'request_booking') for the patient's current issue and received a successful response from the system, DO NOT call that tool again.
- Only call a tool if the patient brings up a brand-new, unrecorded problem or explicitly requests a completely new action. Do not repeat tool execution when a patient simply says "ok", "thank you", or "what now".

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
- Follow up on the patient's wellbeing after their recent visit.
- Listen carefully to any concerns they express.
- If they have a new complaint or medical concern, use the log_complaint tool (once).
- If they want to book a new appointment, use the request_booking tool (once).
- If the situation is urgent or complex, use the request_handoff tool.
- When the conversation reaches a natural conclusion, use the end_conversation tool.
- Be warm, empathetic, and concise — this is WhatsApp, not email.
- Never invent medical advice or diagnoses.
- For rebooking, direct them to call ${clinic.phone || 'the clinic'} or visit ${clinic.address || 'the clinic'}.

CONVERSATION RULES:
- Keep messages short (2-4 sentences max for WhatsApp).
- Never ask more than one question at a time.
- Current turn: ${session.turnCount + 1}`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUILD CLAUDE MESSAGES ARRAY (With Serialization Fix)
  // ═══════════════════════════════════════════════════════════════════════════

  private buildClaudeMessages(
    session: CampaignSession,
  ): { role: 'user' | 'assistant'; content: any }[] {
    return session.messages
      .filter(m => m.content?.trim())
      .map(m => {
        let parsedContent: any = m.content;
        try {
          if (m.content.trim().startsWith('[') || m.content.trim().startsWith('{')) {
            parsedContent = JSON.parse(m.content);
          }
        } catch (e) {
          // Fallback to raw string
        }
        return {
          role: m.role,
          content: parsedContent,
        };
      });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CALL CLAUDE API
  // ═══════════════════════════════════════════════════════════════════════════

  private async callClaude(
    systemPrompt: string,
    messages: { role: 'user' | 'assistant'; content: any }[],
  ): Promise<AnthropicMessage> {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.anthropicApiKey!,
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
    messages: { role: 'user' | 'assistant'; content: any }[],
  ): Promise<AnthropicMessage> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.callClaude(systemPrompt, messages);
      } catch (err: any) {
        lastError = err;
        const status = err.message.match(/status (\d+)/)?.[1];
        if (status && (status === '529' || status.startsWith('5'))) {
          this.logger.warn(`Anthropic API ${status} — retrying (${attempt + 1}/${MAX_RETRIES})`);
          if (attempt < MAX_RETRIES) {
            await delay(RETRY_DELAY * (attempt + 1));
            continue;
          }
        }
        throw err;
      }
    }
    throw lastError!;
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

    this.logger.log(`Complaint logged: ${input.type} / ${input.severity} for patient ${campaignPatientId}`);

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
    session.status = 'admin_handling';

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

    const handoffMsg = await this.fetchBotMessage(clinic.id, MessageKey.CAMPAIGN_HANDOFF_MESSAGE, session.language ?? Language.FR)
      ?? (session.language === Language.EN ? 'An agent will be in touch with you shortly.' : 'Un agent va vous contacter sous peu.');

    if (handoffMsg) {
      try {
        await this.whatsappService.sendText(session.phone, handoffMsg);
      } catch (err: any) {
        this.logger.error(`Failed to send handoff message to patient: ${err.message}`);
      }
    }

    await this.sessionsService.saveCampaignSession(session);

    if (clinic.notificationPhone) {
      try {
        await this.whatsappService.sendText(
          clinic.notificationPhone,
          `🔴 Handoff Required\nPatient: ${session.phone}\nReason: ${input.reason}`
        );
      } catch (err: any) {
        this.logger.error(`Failed to notify staff of handoff: ${err.message}`);
      }
    }

    this.logger.log(`Handoff executed for patient ${campaignPatientId} — reason: ${input.reason}`);
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

    this.logger.log(`Conversation closed for patient ${campaignPatientId} — outcome: ${outcome}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  private detectLanguage(message: string): Language {
    if (/[\u0600-\u06FF]/.test(message)) return Language.AR;
    const lower = message.toLowerCase();
    const frenchWords = ['bonjour', 'merci', 'oui', 'non', 'je', 'vous', 'comment', 'bien', 'bonsoir', 'salam', 'ca va', 'ça va'];
    if (frenchWords.some(w => lower.includes(w))) return Language.FR;
    const englishWords = ['hello', 'hi', 'thanks', 'yes', 'no', 'good', 'how', 'please', 'fine'];
    if (englishWords.some(w => lower.includes(w))) return Language.EN;
    return Language.FR;
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
     return null;
  }
}