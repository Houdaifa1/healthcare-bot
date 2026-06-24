import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { CampaignStatus, CampaignPatientStatus, Language, MessageKey } from '@prisma/client';
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
    // No polling. No re-queue here. resume() finds all PARKED patients and
    // re-queues them with a fresh delay in one shot.
    if (campaign.status === CampaignStatus.PAUSED) {
      this.logger.warn(
        `Campaign ${campaignId} is PAUSED — parking patient ${campaignPatientId}`,
      );

      // Only park if still PENDING — idempotency guard
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
    // PENDING and PARKED are both valid entry states for this processor.
    // Any other status means the job already ran successfully.
    if (
      campaignPatient.status !== CampaignPatientStatus.PENDING &&
      campaignPatient.status !== CampaignPatientStatus.PARKED
    ) {
      this.logger.warn(
        `CampaignPatient ${campaignPatientId} already has status ${campaignPatient.status} — skipping`,
      );
      return;
    }

    // ── 7. Load clinic for language + message fallback ─────────────────────
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: clinicId },
    });

    if (!clinic) {
      this.logger.error(`Clinic ${clinicId} not found — skipping job`);
      return;
    }

    // ── 8. Resolve language ────────────────────────────────────────────────
    // Patient language unknown until they reply — default to clinic language.
    // The AI conversation engine will adapt once the patient replies.
    const language: Language = clinic.defaultLanguage;

    // ── 9. Fetch CAMPAIGN_OPENING_MESSAGE from DB ──────────────────────────
    const openingMessage = await this.fetchBotMessage(
      clinicId,
      MessageKey.CAMPAIGN_OPENING_MESSAGE,
      language,
    );

    if (!openingMessage) {
      this.logger.error(
        `CAMPAIGN_OPENING_MESSAGE not found for clinic ${clinicId} language ${language} — skipping patient ${campaignPatientId}`,
      );
      return;
    }

    // ── 10. Send opening message via WhatsApp ──────────────────────────────
    await this.whatsappService.sendText(campaignPatient.phone, openingMessage);

    this.logger.log(
      `Opening message sent to ${campaignPatient.phone} (${campaignPatient.patientName})`,
    );

    // ── 11. Create campaign Redis session ──────────────────────────────────
    const session: CampaignSession = {
      phone:             campaignPatient.phone,
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
        parkedAt:    null, // clear parkedAt if this patient was previously parked
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