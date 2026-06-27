import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { CampaignStatus, CampaignPatientStatus, Language, MessageKey } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService, CampaignSession } from '../sessions/sessions.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { CampaignOutboundJob } from './campaign.service';
import { QUEUES } from '../queue/queue.constants';

// ─── Template config ───────────────────────────────────────────────────────
// patient_followup template approved by Meta.
// Body: "Bonjour {{1}}, nous faisons suite à votre visite du {{2}}. Comment vous sentez-vous depuis ?"
// {{1}} = patient name
// {{2}} = visit date (dd/MM/yyyy)
const OPENING_TEMPLATE_NAME = 'patient_followup';
const OPENING_TEMPLATE_LANG = 'fr'; // matches the language the template was approved in

@Processor(QUEUES.CAMPAIGN_OUTBOUND)
export class OutboundProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboundProcessor.name);

  constructor(
    private readonly prisma:          PrismaService,
    private readonly sessionsService: SessionsService,
    private readonly whatsappService: WhatsAppService,
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

    // ── 4. PAUSED — park the patient, resume() will re-queue ───────────────
    if (campaign.status === CampaignStatus.PAUSED) {
      this.logger.warn(
        `Campaign ${campaignId} is PAUSED — parking patient ${campaignPatientId}`,
      );

      if (campaignPatient.status === CampaignPatientStatus.PENDING) {
        await this.prisma.campaignPatient.update({
          where: { id: campaignPatientId },
          data: {
            status:   CampaignPatientStatus.PARKED,
            parkedAt: new Date(),
          },
        });
        this.logger.log(
          `CampaignPatient ${campaignPatientId} status → PARKED`,
        );
      }
      return;
    }

    // ── 5. Not RUNNING — unexpected status, skip safely ───────────────────
    if (campaign.status !== CampaignStatus.RUNNING) {
      this.logger.warn(
        `Campaign ${campaignId} has unexpected status ${campaign.status} — skipping patient ${campaignPatientId}`,
      );
      return;
    }

    // ── 6. Idempotency guard — already processed ───────────────────────────
    if (
      campaignPatient.status !== CampaignPatientStatus.PENDING &&
      campaignPatient.status !== CampaignPatientStatus.PARKED
    ) {
      this.logger.warn(
        `CampaignPatient ${campaignPatientId} already has status ${campaignPatient.status} — skipping`,
      );
      return;
    }

    // ── 7. Load clinic ─────────────────────────────────────────────────────
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: clinicId },
    });

    if (!clinic) {
      this.logger.error(`Clinic ${clinicId} not found — skipping job`);
      return;
    }

    // ── 8. Resolve language ────────────────────────────────────────────────
    // Patient language is unknown until they reply — default to clinic language.
    // The AI conversation engine adapts once the patient replies.
    const language: Language = clinic.defaultLanguage;

    // ── 9. Build template variables ────────────────────────────────────────
    // {{1}} = patient name, {{2}} = visit date formatted as dd/MM/yyyy
    const visitDate = new Date(campaignPatient.visitDate).toLocaleDateString('fr-FR');

    // ── 10. Send approved Meta template — works for new contacts ──────────
    // sendText() fails for contacts who have never messaged the clinic before
    // (outside the 24-hour customer-initiated window).
    // sendTemplate() uses the approved patient_followup template which bypasses
    // this restriction and is delivered regardless of prior contact history.
    await this.whatsappService.sendTemplate(
      campaignPatient.phone,
      OPENING_TEMPLATE_NAME,
      OPENING_TEMPLATE_LANG,
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
      `Opening template sent to ${campaignPatient.phone} (${campaignPatient.patientName})`,
    );

    // ── 11. Create campaign Redis session ──────────────────────────────────
    // Normalise phone to match WhatsApp webhook format (no '+' prefix)
    const normalisedPhone = campaignPatient.phone.replace(/^\+/, '').replace(/\s/g, '');

    const session: CampaignSession = {
      phone:             normalisedPhone,
      campaignPatientId: campaignPatient.id,
      clinicId,
      patientSnapshot:   campaignPatient.patientSnapshot as Record<string, any>,
      language:          null,
      messages:          [],
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

    // ── 12. Update CampaignPatient → CONTACTED ─────────────────────────────
    await this.prisma.campaignPatient.update({
      where: { id: campaignPatientId },
      data: {
        status:      CampaignPatientStatus.CONTACTED,
        contactedAt: new Date(),
        parkedAt:    null,
      },
    });

    // ── 13. Increment Campaign.contactedCount ──────────────────────────────
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