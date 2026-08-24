import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { CampaignStatus, CampaignPatientStatus, DeliveryStatus, Language, MessageKey } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService, CampaignSession } from '../sessions/sessions.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { CampaignOutboundJob } from './campaign.service';
import { QUEUES } from '../queue/queue.constants';

@Processor(QUEUES.CAMPAIGN_OUTBOUND)
export class OutboundProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboundProcessor.name);

  constructor(
    private readonly prisma:          PrismaService,
    private readonly sessionsService: SessionsService,
    private readonly whatsappService: WhatsAppService,
    private readonly configService:   ConfigService,
  ) {
    super();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN PROCESSOR
  // ═══════════════════════════════════════════════════════════════════════════

  async process(job: Job<CampaignOutboundJob>): Promise<void> {
    const { campaignPatientId, campaignId, clinicId } = job.data;

    this.logger.log(
      `Processing outbound job for campaignPatient=${campaignPatientId} campaign=${campaignId}`,
    );

    // ── 1. Load CampaignPatient ────────────────────────────────────────────
    const campaignPatient = await this.prisma.campaignPatient.findUnique({
      where: { id: campaignPatientId },
    });

    if (!campaignPatient) {
      this.logger.error(
        `CampaignPatient ${campaignPatientId} not found — skipping job`,
      );
      return;
    }

    // ── 2. Load Campaign ───────────────────────────────────────────────────
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
    });

    if (!campaign) {
      this.logger.error(`Campaign ${campaignId} not found — skipping job`);
      return;
    }

    // ── 3. STOPPED — drop permanently, no action ───────────────────────────
    if (campaign.status === CampaignStatus.STOPPED) {
      this.logger.warn(
        `Campaign ${campaignId} is STOPPED — dropping patient ${campaignPatientId} permanently`,
      );
      return;
    }

    // ── 4. Not RUNNING — unexpected status, skip safely ───────────────────
    if (campaign.status !== CampaignStatus.RUNNING) {
      this.logger.warn(
        `Campaign ${campaignId} has unexpected status ${campaign.status} — skipping patient ${campaignPatientId}`,
      );
      return;
    }

    // ── 5. Idempotency guard — already processed ───────────────────────────
    if (campaignPatient.status !== CampaignPatientStatus.PENDING) {
      this.logger.warn(
        `CampaignPatient ${campaignPatientId} already has status ${campaignPatient.status} — skipping`,
      );
      return;
    }

    // ── 6. Load clinic ─────────────────────────────────────────────────────
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: clinicId },
    });

    if (!clinic) {
      this.logger.error(`Clinic ${clinicId} not found — skipping job`);
      return;
    }

    // ── 7. Resolve language ────────────────────────────────────────────────
    // Patient language is unknown until they reply — default to clinic language.
    // The AI conversation engine adapts once the patient replies.
    const language: Language = clinic.defaultLanguage;

    // ── 8. Build template variables ────────────────────────────────────────
    // {{1}} = patient name, {{2}} = visit date formatted as dd/MM/yyyy
    const visitDate = new Date(campaignPatient.visitDate).toLocaleDateString('fr-FR');

    // ── 9. Send approved Meta template — works for new contacts ───────────
    // sendText() fails for contacts who have never messaged the clinic before
    // (outside the 24-hour customer-initiated window).
    // sendTemplate() uses the approved template which bypasses this restriction
    // and is delivered regardless of prior contact history. The template name
    // and language come from config — they are account-specific and must match
    // the template actually approved in Meta Business Manager.
    const openingTemplateName = this.configService.get<string>('campaign.openingTemplateName') ?? 'patient_followup';
    const openingTemplateLanguage = this.configService.get<string>('campaign.openingTemplateLanguage') ?? 'fr';

    const wamId = await this.whatsappService.sendTemplate(
      campaignPatient.phone,
      openingTemplateName,
      openingTemplateLanguage,
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: campaignPatient.patientName },
            { type: 'text', text: visitDate },
          ],
        },
      ],
    );

    this.logger.log(
      `Opening template sent to ${campaignPatient.phone} (${campaignPatient.patientName}) — wamid=${wamId}`,
    );

    // ── 10. Create campaign Redis session ──────────────────────────────────
    // Normalise phone to match WhatsApp webhook format (no '+' prefix)
    const normalisedPhone = campaignPatient.phone.replace(/^\+/, '').replace(/\s/g, '');

    // The actual WhatsApp message is the Meta-approved template above — its
    // wording lives in Meta Business Manager and can't come from our DB. This
    // is only the local echo of that message: what the dashboard shows in the
    // conversation history and what the AI treats as its own prior turn, so
    // it should still reflect the DB-editable, clinic-language CAMPAIGN_OPENING_MESSAGE
    // rather than being hardcoded French regardless of the clinic's language.
    const openingTemplate = await this.fetchBotMessage(clinicId, MessageKey.CAMPAIGN_OPENING_MESSAGE, language)
      ?? 'Bonjour {{name}}, nous faisons suite à votre visite du {{visitDate}}. Comment vous sentez-vous depuis ?';
    const openingText = openingTemplate
      .replace(/\{\{name\}\}/g, campaignPatient.patientName)
      .replace(/\{\{visitDate\}\}/g, visitDate);

    const session: CampaignSession = {
      phone:             normalisedPhone,
      campaignPatientId: campaignPatient.id,
      clinicId,
      patientSnapshot:   campaignPatient.patientSnapshot as Record<string, any>,
      language:          null,
      messages:          [
        // Log the opening template message so the model has full conversation context
        { role: 'assistant', content: openingText, timestamp: Date.now() },
      ],
      turnCount:         0,
      remindersSent:     0,
      status:            'awaiting_reply',
      startedAt:         Date.now(),
      lastActivityAt:    Date.now(),
    };

    await this.sessionsService.saveCampaignSession(session);

    this.logger.log(
      `Campaign session created in Redis for ${campaignPatient.phone}`,
    );

    // ── 11. Update CampaignPatient → CONTACTED + record delivery tracking ──
    // Only reach this point if sendTemplate() actually succeeded (Meta accepted
    // the message with a wamid). Record the wamid + initial SENT status so the
    // delivery webhook can update it to DELIVERED/READ/FAILED later, and so the
    // dashboard can show true delivery state rather than just "job dispatched".
    await this.prisma.campaignPatient.update({
      where: { id: campaignPatientId },
      data: {
        status:            CampaignPatientStatus.CONTACTED,
        contactedAt:       new Date(),
        parkedAt:          null,
        outboundMessageId: wamId || null,
        deliveryStatus:    wamId ? DeliveryStatus.SENT : null,
        // Persist the opening message immediately so the dashboard's
        // conversation view shows it right away — otherwise it stays empty
        // until the patient's first reply triggers ConversationService to
        // persist the Redis session (opening line + reply) to Postgres.
        messages:          session.messages as any,
      },
    });

    // ── 12. Increment Campaign.contactedCount ──────────────────────────────
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data:  { contactedCount: { increment: 1 } },
    });

    this.logger.log(
      `CampaignPatient ${campaignPatientId} status → CONTACTED, campaign contactedCount incremented`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Fetches a single bot message body from the DB.
   * Falls back to FR if the requested language has no record.
   * Returns null if neither the requested language nor FR has a record.
   */
  private async fetchBotMessage(
    clinicId: string,
    key:      MessageKey,
    language: Language,
  ): Promise<string | null> {
    const record = await this.prisma.botMessage.findUnique({
      where: {
        clinicId_key_language: { clinicId, key, language },
      },
    });

    if (record) return record.body;

    if (language !== Language.FR) {
      this.logger.warn(
        `BotMessage ${key} not found for language ${language} — falling back to FR`,
      );
      const fallback = await this.prisma.botMessage.findUnique({
        where: {
          clinicId_key_language: { clinicId, key, language: Language.FR },
        },
      });
      if (fallback) return fallback.body;
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WORKER EVENTS
  // ═══════════════════════════════════════════════════════════════════════════

  @OnWorkerEvent('ready')
  onReady(): void {
    this.logger.log('Outbound campaign worker ready');
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error('Outbound worker error:', error.message);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error): void {
    this.logger.error(
      `Outbound job ${job.id} failed after all retries: ${error.message}`,
    );
  }
}