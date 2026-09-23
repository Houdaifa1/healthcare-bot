import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '@platform/database/prisma.service';
import { SessionsService } from '@platform/cache/sessions.service';
import { WhatsAppService } from '@integrations/whatsapp/whatsapp.service';
import { normalizePatientPhone } from '@platform/shared/phone.util';
import {
  CampaignPatientStatus,
  CampaignStatus,
  ConversationOutcome,
} from '@prisma/client';

@Injectable()
export class ReminderService {
  private readonly logger = new Logger(ReminderService.name);
  private isRunning = false;

  constructor(
    private readonly prisma:          PrismaService,
    private readonly sessionsService: SessionsService,
    private readonly whatsappService: WhatsAppService,
    private readonly configService: ConfigService,
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
          reminderAttemptAt: true,
        },
      });

      if (eligiblePatients.length > 0) {
        this.logger.log(`Campaign ${campaign.id}: ${eligiblePatients.length} patients eligible for reminder`);
      }

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

      const remaining = await this.prisma.campaignPatient.count({
        where: {
          campaignId: campaign.id,
          status: { in: [
            CampaignPatientStatus.PENDING,
            CampaignPatientStatus.SENDING,
            CampaignPatientStatus.PARKED,
            CampaignPatientStatus.CONTACTED,
            CampaignPatientStatus.REPLIED,
          ] },
        },
      });
      const total = await this.prisma.campaignPatient.count({ where: { campaignId: campaign.id } });
      if (total > 0 && remaining === 0) {
        await this.prisma.campaign.updateMany({
          where: { id: campaign.id, status: CampaignStatus.RUNNING },
          data: { status: CampaignStatus.COMPLETED, completedAt: new Date() },
        });
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
      reminderAttemptAt: Date | null;
    },
    campaignId:    string,
    clinicId:      string,
    reminderCount: number,
  ): Promise<void> {
    const suppression = await this.prisma.contactSuppression.findUnique({
      where: { clinicId_phoneNormalized: { clinicId,
        phoneNormalized: normalizePatientPhone(patient.phone) } },
    });
    if (suppression) {
      const closed = await this.prisma.campaignPatient.updateMany({
        where: { id: patient.id, status: CampaignPatientStatus.CONTACTED },
        data: { status: CampaignPatientStatus.OPTED_OUT,
          outcome: ConversationOutcome.OPTED_OUT, completedAt: new Date() },
      });
      if (closed.count === 1) {
        await this.prisma.campaign.update({
          where: { id: campaignId }, data: { completedCount: { increment: 1 } },
        });
      }
      return;
    }
    if (patient.reminderAttemptAt) {
      this.logger.warn(`Reminder outcome requires reconciliation for patient ${patient.id}`);
      return;
    }
    if (patient.remindersSent < reminderCount) {
      await this.sendReminder(patient);
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
      reminderAttemptAt: Date | null;
    },
  ): Promise<void> {
    const visitDate = new Date(patient.visitDate).toLocaleDateString('fr-FR');

    const templateName = this.configService.get<string>('campaign.reminderTemplateName');
    const templateLanguage = this.configService.get<string>('campaign.reminderTemplateLanguage', 'fr');
    if (!templateName) {
      this.logger.error(`No approved reminder template configured; reminder for patient ${patient.id} was not sent`);
      return;
    }

    const claimed = await this.prisma.campaignPatient.updateMany({
      where: { id: patient.id, status: CampaignPatientStatus.CONTACTED,
        remindersSent: patient.remindersSent, reminderAttemptAt: null },
      data: { reminderAttemptAt: new Date(), reminderAttemptState: 'SUBMITTING' },
    });
    if (claimed.count !== 1) return;

    try {
      await this.whatsappService.sendTemplate(patient.phone, templateName, templateLanguage, [{
        type: 'body',
        parameters: [
          { type: 'text', text: patient.patientName },
          { type: 'text', text: visitDate },
        ],
      }]);
    } catch (error) {
      await this.prisma.campaignPatient.update({
        where: { id: patient.id }, data: { reminderAttemptState: 'RECONCILE' },
      }).catch(() => undefined);
      throw error;
    }

    await this.prisma.campaignPatient.update({
      where: { id: patient.id },
      data:  { remindersSent: { increment: 1 }, reminderAttemptAt: null,
        reminderAttemptState: null },
    });

    // Sync remindersSent to Redis session so AI has accurate state on reply
    const session = await this.sessionsService.getCampaignSession(patient.phone);
    if (session) {
      session.remindersSent = patient.remindersSent + 1;
      await this.sessionsService.saveCampaignSession(session);
    }

    this.logger.log(
      `Reminder ${patient.remindersSent + 1} sent for campaign patient ${patient.id}`,
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
      `Campaign patient ${patient.id} marked NO_RESPONSE — all reminders exhausted`,
    );
  }

}
