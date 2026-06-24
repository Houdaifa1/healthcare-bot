import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import {
  CampaignPatientStatus,
  CampaignStatus,
  ConversationOutcome,
  Language,
  MessageKey,
} from '@prisma/client';

@Injectable()
export class ReminderService {
  private readonly logger = new Logger(ReminderService.name);

  // Guard against overlapping runs — if the previous cron tick is still
  // processing when the next one fires, skip it entirely.
  private isRunning = false;

  constructor(
    private readonly prisma:          PrismaService,
    private readonly sessionsService: SessionsService,
    private readonly whatsappService: WhatsAppService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // CRON — runs every hour
  // ═══════════════════════════════════════════════════════════════════════════

  @Cron(CronExpression.EVERY_HOUR)
  async runReminderCycle(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Reminder cycle already running — skipping this tick');
      return;
    }

    this.isRunning = true;
    this.logger.log('Reminder cycle started');

    try {
      await this.processReminders();
    } catch (err: any) {
      this.logger.error(`Reminder cycle failed: ${err.message}`, err.stack);
    } finally {
      this.isRunning = false;
      this.logger.log('Reminder cycle complete');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CORE LOGIC
  // ═══════════════════════════════════════════════════════════════════════════

  private async processReminders(): Promise<void> {
    // Load all RUNNING campaigns so we can batch-resolve their settings.
    // We only send reminders for patients whose campaign is still RUNNING.
    const runningCampaigns = await this.prisma.campaign.findMany({
      where:  { status: CampaignStatus.RUNNING },
      select: {
        id:                   true,
        clinicId:             true,
        reminderCount:        true,
        reminderIntervalHours: true,
      },
    });

    if (runningCampaigns.length === 0) {
      this.logger.log('No running campaigns — nothing to do');
      return;
    }

    // Build a map of campaignId → resolved settings for fast lookup below.
    // We need clinic defaults for campaigns that don't override them.
    const clinicIds = [...new Set(runningCampaigns.map(c => c.clinicId))];
    const clinics   = await this.prisma.clinic.findMany({
      where:  { id: { in: clinicIds } },
      select: {
        id:                   true,
        reminderCount:        true,
        reminderIntervalHours: true,
      },
    });

    const clinicMap = new Map(clinics.map(c => [c.id, c]));

    // For each running campaign, find CONTACTED patients whose updatedAt is
    // older than the campaign's reminderIntervalHours.
    let totalProcessed = 0;

    for (const campaign of runningCampaigns) {
      const clinic = clinicMap.get(campaign.clinicId);
      if (!clinic) {
        this.logger.warn(`Clinic ${campaign.clinicId} not found for campaign ${campaign.id} — skipping`);
        continue;
      }

      // Resolve settings — campaign override takes precedence
      const reminderCount         = campaign.reminderCount         ?? clinic.reminderCount;
      const reminderIntervalHours = campaign.reminderIntervalHours ?? clinic.reminderIntervalHours;

      // Cutoff timestamp — patients not touched since before this time are eligible
      const cutoff = new Date(Date.now() - reminderIntervalHours * 60 * 60 * 1000);

      // Find all CONTACTED patients for this campaign that have been silent
      // for at least reminderIntervalHours
      const eligiblePatients = await this.prisma.campaignPatient.findMany({
        where: {
          campaignId: campaign.id,
          status:     CampaignPatientStatus.CONTACTED,
          updatedAt:  { lt: cutoff },
        },
      });

      if (eligiblePatients.length === 0) continue;

      this.logger.log(
        `Campaign ${campaign.id}: ${eligiblePatients.length} patients eligible for reminder`,
      );

      for (const patient of eligiblePatients) {
        try {
          await this.processOnePatient(
            patient,
            campaign.id,
            campaign.clinicId,
            reminderCount,
            reminderIntervalHours,
          );
          totalProcessed++;
        } catch (err: any) {
          // One patient failing must not stop the rest
          this.logger.error(
            `Failed to process reminder for patient ${patient.id}: ${err.message}`,
          );
        }
      }
    }

    this.logger.log(`Reminder cycle processed ${totalProcessed} patients`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROCESS ONE PATIENT
  // ═══════════════════════════════════════════════════════════════════════════

  private async processOnePatient(
    patient:              { id: string; phone: string; remindersSent: number; language: Language | null },
    campaignId:           string,
    clinicId:             string,
    reminderCount:        number,
    reminderIntervalHours: number,
  ): Promise<void> {
    if (patient.remindersSent < reminderCount) {
      // ── Still have reminders left — send one ──────────────────────────
      await this.sendReminder(patient, clinicId, campaignId, reminderIntervalHours);
    } else {
      // ── All reminders exhausted — mark as NO_RESPONSE ─────────────────
      await this.markNoResponse(patient, campaignId);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SEND REMINDER
  // ═══════════════════════════════════════════════════════════════════════════

  private async sendReminder(
    patient:              { id: string; phone: string; remindersSent: number; language: Language | null },
    clinicId:             string,
    campaignId:           string,
    reminderIntervalHours: number,
  ): Promise<void> {
    // Resolve language — fall back to FR if unknown
    const language = patient.language ?? Language.FR;

    // Fetch reminder message from DB
    const reminderBody = await this.fetchBotMessage(
      clinicId,
      MessageKey.CAMPAIGN_REMINDER_MESSAGE,
      language,
    );

    if (!reminderBody) {
      this.logger.error(
        `CAMPAIGN_REMINDER_MESSAGE not found for clinic ${clinicId} language ${language} — skipping patient ${patient.id}`,
      );
      return;
    }

    // Send WhatsApp message
    await this.whatsappService.sendText(patient.phone, reminderBody);

    // Update patient record — bump remindersSent and touch updatedAt so the
    // interval resets correctly for the next reminder check
    await this.prisma.campaignPatient.update({
      where: { id: patient.id },
      data:  { remindersSent: { increment: 1 } },
    });

    // Update campaign Redis session remindersSent count so the AI engine
    // has accurate state if the patient replies after this reminder
    const session = await this.sessionsService.getCampaignSession(patient.phone);
    if (session) {
      session.remindersSent = patient.remindersSent + 1;
      await this.sessionsService.saveCampaignSession(session);
    }

    this.logger.log(
      `Reminder ${patient.remindersSent + 1} sent to ${patient.phone} (patient ${patient.id})`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MARK NO RESPONSE
  // ═══════════════════════════════════════════════════════════════════════════

  private async markNoResponse(
    patient:    { id: string; phone: string },
    campaignId: string,
  ): Promise<void> {
    // Update patient record
    await this.prisma.campaignPatient.update({
      where: { id: patient.id },
      data: {
        status:      CampaignPatientStatus.NO_RESPONSE,
        outcome:     ConversationOutcome.NO_RESPONSE,
        completedAt: new Date(),
      },
    });

    // Increment campaign noResponseCount
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data:  { noResponseCount: { increment: 1 } },
    });

    // Clean up Redis session — no point keeping it alive
    await this.sessionsService.deleteCampaignSession(patient.phone);

    this.logger.log(
      `Patient ${patient.id} (${patient.phone}) marked NO_RESPONSE — all reminders exhausted`,
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
      where: { clinicId_key_language: { clinicId, key, language } },
    });

    if (record) return record.body;

    if (language !== Language.FR) {
      this.logger.warn(
        `BotMessage ${key} not found for language ${language} — falling back to FR`,
      );
      const fallback = await this.prisma.botMessage.findUnique({
        where: { clinicId_key_language: { clinicId, key, language: Language.FR } },
      });
      if (fallback) return fallback.body;
    }

    return null;
  }
}