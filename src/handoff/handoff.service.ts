import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { SessionsService } from '../sessions/sessions.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  BookingSource,
  HandoffStatus,
  CampaignPatientStatus,
  ConversationOutcome,
  Language,
} from '@prisma/client';

export interface HandoffSessionData {
  id:                 string;
  source:             BookingSource;
  campaignPatientId:  string | null;
  campaignId:         string | null;
  patientName:        string;
  phone:              string;
  language:           string | null;
  messages:           { role: string; content: string; timestamp: number }[];
  turnCount:          number;
  handoffReason:      string;
  handedOffAt:        number;
  lastActivityAt:     number;
}

export interface CreateHandoffInput {
  clinicId:          string;
  source:             BookingSource;
  phone:             string;
  patientName?:      string | null;
  campaignPatientId?: string | null;
  reason?:           string | null;
  language?:         Language | null;
  // Prior conversation transcript, if one exists (CAMPAIGN handoffs carry the
  // AI conversation so far; INBOUND has no equivalent transcript to carry).
  messages?:         { role: string; content: string; timestamp: number }[];
  // Optional extra context shown in the admin alert when available (CAMPAIGN
  // handoffs have this from ClinOps history; INBOUND ones typically don't).
  ageYears?:         number | null;
  ville?:            string | null;
  visitDate?:        Date | null;
  prestation?:       string | null;
  medecinTraitant?:  string | null;
}

@Injectable()
export class HandoffService {
  private readonly logger = new Logger(HandoffService.name);

  constructor(
    private readonly sessionsService: SessionsService,
    private readonly whatsappService: WhatsAppService,
    private readonly prisma:         PrismaService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // CREATE — single entry point for both inbound and campaign flows.
  // Persists the Handoff row and sends the admin the exact same WhatsApp alert
  // regardless of source.
  // ═══════════════════════════════════════════════════════════════════════════

  async createHandoff(input: CreateHandoffInput) {
    const handoff = await this.prisma.handoff.create({
      data: {
        clinicId:          input.clinicId,
        source:            input.source,
        phone:             input.phone,
        patientName:       input.patientName ?? null,
        campaignPatientId: input.campaignPatientId ?? null,
        reason:            input.reason ?? null,
        language:          input.language ?? null,
        messages:          (input.messages ?? []) as any,
      },
    });

    const clinic = await this.prisma.clinic.findUnique({
      where: { id: input.clinicId },
      select: { notificationPhone: true },
    });

    if (clinic?.notificationPhone) {
      try {
        const now = new Date().toLocaleString('fr-MA', { timeZone: 'Africa/Casablanca' });

        // Same template for both sources — the visit-history block only
        // appears when that context actually exists (CAMPAIGN handoffs carry
        // it from ClinOps; INBOUND ones don't have prior-visit data to show).
        const visitBlock =
          input.visitDate || input.prestation || input.medecinTraitant || input.ageYears != null || input.ville
            ? `Age       : ${input.ageYears ?? 'N/A'} years\n` +
              `City      : ${input.ville ?? 'N/A'}\n---------------------------\n` +
              `Last visit   : ${input.visitDate ? input.visitDate.toLocaleDateString('fr-FR') : 'N/A'}\n` +
              `Visit reason : ${input.prestation ?? 'N/A'}\n` +
              `Doctor       : ${input.medecinTraitant ?? 'N/A'}\n---------------------------\n`
            : '';

        const notification =
          `PATIENT HANDOFF REQUIRED\n---------------------------\n` +
          `Name      : ${input.patientName ?? 'Unknown'}\n` +
          `Phone     : ${input.phone}\n---------------------------\n` +
          visitBlock +
          `Handoff reason : ${input.reason ?? 'No reason provided.'}\n---------------------------\n` +
          `Time : ${now}\nAction required : Contact this patient immediately.`;

        await this.whatsappService.sendText(clinic.notificationPhone, notification);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to notify staff of handoff: ${msg}`);
      }
    }

    this.logger.log(`Handoff ${handoff.id} created for ${input.phone} (source: ${input.source})`);
    return handoff;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // READ — active handoffs across both sources, for the admin dashboard.
  // ═══════════════════════════════════════════════════════════════════════════

  async getHandoffSessions(): Promise<HandoffSessionData[]> {
    const rows = await this.prisma.handoff.findMany({
      where: { status: { in: [HandoffStatus.OPEN, HandoffStatus.ADMIN_HANDLING] } },
      include: { campaignPatient: { select: { campaignId: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((row) => {
      const messages = (row.messages as HandoffSessionData['messages']) ?? [];
      return {
        id:                row.id,
        source:            row.source,
        campaignPatientId: row.campaignPatientId,
        campaignId:        row.campaignPatient?.campaignId ?? null,
        patientName:       row.patientName ?? 'Unknown',
        phone:             row.phone,
        language:          row.language,
        messages,
        turnCount:         messages.length,
        handoffReason:     row.reason ?? 'No reason recorded',
        handedOffAt:       row.createdAt.getTime(),
        lastActivityAt:    row.lastActivityAt.getTime(),
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SEND MESSAGE — staff replies to a handed-off patient from the dashboard.
  // ═══════════════════════════════════════════════════════════════════════════

  async sendMessage(phone: string, message: string): Promise<void> {
    if (!message?.trim()) {
      throw new BadRequestException('Message cannot be empty');
    }

    const handoff = await this.findOpenHandoffByPhone(phone);
    if (!handoff) {
      throw new NotFoundException(`No active handoff found for ${phone}`);
    }

    await this.whatsappService.sendText(phone, message.trim());

    const messages = [
      ...((handoff.messages as HandoffSessionData['messages']) ?? []),
      { role: 'assistant', content: message.trim(), timestamp: Date.now() },
    ];

    await this.prisma.handoff.update({
      where: { id: handoff.id },
      data: { messages, lastActivityAt: new Date() },
    });

    // Campaign handoffs also mirror into the pre-existing Redis/CampaignPatient
    // transcript, which other campaign-side views/logic still read from.
    if (handoff.source === BookingSource.CAMPAIGN) {
      const session = await this.sessionsService.getCampaignSession(phone);
      if (session) {
        session.messages.push({ role: 'assistant', content: message.trim(), timestamp: Date.now() });
        await this.sessionsService.saveCampaignSession(session);
      }
      if (handoff.campaignPatientId) {
        await this.prisma.campaignPatient.update({
          where: { id: handoff.campaignPatientId },
          data: { messages: messages as any },
        }).catch(() => {
          this.logger.warn(`Failed to persist message to CampaignPatient for ${phone}`);
        });
      }
    }

    this.logger.log(`Staff message sent to ${phone} via handoff ${handoff.id}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RECORD PATIENT REPLY — called while a handoff is open, for either source,
  // so the transcript captures what the patient said while waiting for staff.
  // ═══════════════════════════════════════════════════════════════════════════

  async recordPatientMessage(phone: string, text: string): Promise<boolean> {
    const handoff = await this.findOpenHandoffByPhone(phone);
    if (!handoff) return false;

    const messages = [
      ...((handoff.messages as HandoffSessionData['messages']) ?? []),
      { role: 'user', content: text, timestamp: Date.now() },
    ];

    await this.prisma.handoff.update({
      where: { id: handoff.id },
      data: { messages, lastActivityAt: new Date() },
    });

    if (handoff.source === BookingSource.CAMPAIGN && handoff.campaignPatientId) {
      await this.prisma.campaignPatient.update({
        where: { id: handoff.campaignPatientId },
        data: { messages: messages as any },
      }).catch(() => {
        this.logger.warn(`Failed to persist handoff message to CampaignPatient for ${phone}`);
      });
    }

    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RESOLVE — staff marks a handoff done from the dashboard.
  // ═══════════════════════════════════════════════════════════════════════════

  async resolveHandoff(phone: string): Promise<void> {
    const handoff = await this.findOpenHandoffByPhone(phone);
    if (!handoff) {
      this.logger.warn(`resolveHandoff: no active handoff found for ${phone}`);
      return;
    }

    await this.prisma.handoff.update({
      where: { id: handoff.id },
      data: { status: HandoffStatus.RESOLVED, resolvedAt: new Date() },
    });

    if (handoff.source === BookingSource.CAMPAIGN) {
      const session = await this.sessionsService.getCampaignSession(phone);
      if (session) {
        session.status = 'completed';
        await this.sessionsService.saveCampaignSession(session);
      }
      if (handoff.campaignPatientId) {
        await this.prisma.campaignPatient.update({
          where: { id: handoff.campaignPatientId },
          data: {
            status:      CampaignPatientStatus.COMPLETED,
            outcome:     ConversationOutcome.HANDED_OFF,
            completedAt: new Date(),
          },
        }).catch(() => {
          this.logger.warn(`Failed to update CampaignPatient status on resolve for ${phone}`);
        });
      }
    }

    this.logger.log(`Handoff ${handoff.id} resolved for ${phone}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Whether a phone currently has an open handoff — used by inbound routing to
  // keep the reactive orchestrator paused until staff resolve it.
  // ═══════════════════════════════════════════════════════════════════════════

  async hasOpenHandoff(phone: string): Promise<boolean> {
    return (await this.findOpenHandoffByPhone(phone)) !== null;
  }

  private async findOpenHandoffByPhone(phone: string) {
    return this.prisma.handoff.findFirst({
      where: { phone, status: { in: [HandoffStatus.OPEN, HandoffStatus.ADMIN_HANDLING] } },
      orderBy: { createdAt: 'desc' },
    });
  }
}
