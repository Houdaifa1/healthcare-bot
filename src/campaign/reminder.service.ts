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
  private isRunning = false;

  constructor(
    private readonly prisma:          PrismaService,
    private readonly sessionsService: SessionsService,
    private readonly whatsappService: WhatsAppService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // CRON — every hour
  // ═══════════════════════════════════════════════════════════════════════════

  @Cron(CronExpression.EVERY_HOUR)
  async runReminderCycle(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Reminder cycle already running — skipping tick');
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
    const runningCampaigns = await this.prisma.campaign.findMany({
      where:  { status: CampaignStatus.RUNNING },
      select: {
        id:                    true,
        clinicId:              true,
        reminderCount:         true,
        reminderIntervalHours: true,
      },
    });

    if (runningCampaigns.length === 0) {
      this.logger.log('No running campaigns — nothing to do');
      return;
    }

    const clinicIds = [...new Set(runningCampaigns.map(c => c.clinicId))];
    const clinics   = await this.prisma.clinic.findMany({
      where:  { id: { in: clinicIds } },
      select: {
        id:                    true,
        name:                  true,
        phone:                 true,
        reminderCount:         true,
        reminderIntervalHours: true,
      },
    });

    const clinicMap = new Map(clinics.map(c => [c.id, c]));
    let totalProcessed = 0;

    for (const campaign of runningCampaigns) {
      const clinic = clinicMap.get(campaign.clinicId);
      if (!clinic) {
        this.logger.warn(`Clinic ${campaign.clinicId} not found for campaign ${campaign.id} — skipping`);
        continue;
      }

      const reminderCount         = campaign.reminderCount         ?? clinic.reminderCount;
      const reminderIntervalHours = campaign.reminderIntervalHours ?? clinic.reminderIntervalHours;
      const cutoff                = new Date(Date.now() - reminderIntervalHours * 60 * 60 * 1000);

      const eligiblePatients = await this.prisma.campaignPatient.findMany({
        where: {
          campaignId: campaign.id,
          status:     CampaignPatientStatus.CONTACTED,
          updatedAt:  { lt: cutoff },
        },
        select: {
          id:            true,
          phone:         true,
          patientName:   true,
          visitDate:     true,
          remindersSent: true,
          language:      true,
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
          );
          totalProcessed++;
        } catch (err: any) {
          this.logger.error(`Reminder failed for patient ${patient.id}: ${err.message}`);
        }
      }
    }

    this.logger.log(`Reminder cycle processed ${totalProcessed} patients`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROCESS ONE PATIENT
  // ═══════════════════════════════════════════════════════════════════════════

  private async processOnePatient(
    patient: {
      id:            string;
      phone:         string;
      patientName:   string;
      visitDate:     Date;
      remindersSent: number;
      language:      Language | null;
    },
    campaignId:    string,
    clinicId:      string,
    reminderCount: number,
  ): Promise<void> {
    if (patient.remindersSent < reminderCount) {
      await this.sendReminder(patient, clinicId, campaignId);
    } else {
      await this.markNoResponse(patient, campaignId);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SEND REMINDER
  // ═══════════════════════════════════════════════════════════════════════════

  private async sendReminder(
    patient: {
      id:            string;
      phone:         string;
      patientName:   string;
      visitDate:     Date;
      remindersSent: number;
      language:      Language | null;
    },
    clinicId:   string,
    campaignId: string,
  ): Promise<void> {
    const language  = patient.language ?? Language.FR;
    const visitDate = new Date(patient.visitDate).toLocaleDateString('fr-FR');

    // Fetch reminder message with variable substitution
    const reminderBody = await this.fetchBotMessage(
      clinicId,
      MessageKey.CAMPAIGN_REMINDER_MESSAGE,
      language,
      {
        name:      patient.patientName,
        visitDate,
      },
    );

    if (!reminderBody) {
      this.logger.error(
        `CAMPAIGN_REMINDER_MESSAGE not found for clinic ${clinicId} language ${language} — skipping patient ${patient.id}`,
      );
      return;
    }

    await this.whatsappService.sendText(patient.phone, reminderBody);

    await this.prisma.campaignPatient.update({
      where: { id: patient.id },
      data:  { remindersSent: { increment: 1 } },
    });

    // Sync remindersSent to Redis session so AI has accurate state on reply
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
    await this.prisma.campaignPatient.update({
      where: { id: patient.id },
      data: {
        status:      CampaignPatientStatus.NO_RESPONSE,
        outcome:     ConversationOutcome.NO_RESPONSE,
        completedAt: new Date(),
      },
    });

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data:  { noResponseCount: { increment: 1 } },
    });

    await this.sessionsService.deleteCampaignSession(patient.phone);

    this.logger.log(
      `Patient ${patient.id} (${patient.phone}) marked NO_RESPONSE — all reminders exhausted`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Fetches a bot message body from DB with FR fallback and variable substitution.
   */
  private async fetchBotMessage(
    clinicId:   string,
    key:        MessageKey,
    language:   Language,
    variables?: Record<string, string>,
  ): Promise<string | null> {
    const record = await this.prisma.botMessage.findUnique({
      where: { clinicId_key_language: { clinicId, key, language } },
    });

    let body = record?.body ?? null;

    if (!body && language !== Language.FR) {
      this.logger.warn(`BotMessage ${key} not found for ${language} — falling back to FR`);
      const fallback = await this.prisma.botMessage.findUnique({
        where: { clinicId_key_language: { clinicId, key, language: Language.FR } },
      });
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