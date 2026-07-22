import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { SessionsService, CampaignSession } from '../sessions/sessions.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { PrismaService } from '../prisma/prisma.service';

export interface HandoffSessionData {
  campaignPatientId: string;
  campaignId: string;
  patientName: string;
  phone: string;
  language: string | null;
  messages: { role: string; content: string; timestamp: number }[];
  turnCount: number;
  handoffReason: string;
  handedOffAt: number;
  lastActivityAt: number;
}

@Injectable()
export class HandoffService {
  private readonly logger = new Logger(HandoffService.name);

  constructor(
    private readonly sessionsService: SessionsService,
    private readonly whatsappService: WhatsAppService,
    private readonly prisma: PrismaService,
  ) {}

  async getHandoffSessions(): Promise<HandoffSessionData[]> {
    const keys = await this.sessionsService.scanCampaignKeys();
    if (keys.length === 0) return [];

    const results: HandoffSessionData[] = [];
    const redis = this.sessionsService.getClient();

    for (const key of keys) {
      try {
        const raw = await redis.get(key);
        if (!raw) continue;

        const session: CampaignSession = JSON.parse(raw);
        if (
          session.status !== 'handed_off' &&
          session.status !== 'admin_handling'
        )
          continue;

        const patient = await this.prisma.campaignPatient.findUnique({
          where: { id: session.campaignPatientId },
          select: { id: true, patientName: true, campaignId: true },
        });

        if (!patient) continue;

        // Get the last AI message that triggered the handoff
        const lastAiMsg = [...session.messages]
          .reverse()
          .find((m) => m.role === 'assistant');

        results.push({
          campaignPatientId: session.campaignPatientId,
          campaignId: patient.campaignId,
          patientName: patient.patientName,
          phone: session.phone,
          language: session.language,
          messages: session.messages,
          turnCount: session.turnCount,
          handoffReason: lastAiMsg?.content ?? 'No reason recorded',
          handedOffAt: session.startedAt,
          lastActivityAt: session.lastActivityAt,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to parse campaign session key "${key}": ${msg}`,
        );
      }
    }

    results.sort((a, b) => b.handedOffAt - a.handedOffAt);
    this.logger.log(`Found ${results.length} handoff session(s)`);
    return results;
  }

  async sendMessage(phone: string, message: string): Promise<void> {
    if (!message?.trim()) {
      throw new BadRequestException('Message cannot be empty');
    }

    const session = await this.sessionsService.getCampaignSession(phone);
    if (!session) {
      throw new NotFoundException(`No campaign session found for ${phone}`);
    }

    if (
      session.status !== 'handed_off' &&
      session.status !== 'admin_handling'
    ) {
      throw new BadRequestException(
        `Session for ${phone} is in status "${session.status}" — not a handoff session`,
      );
    }

    await this.whatsappService.sendText(phone, message.trim());

    session.messages.push({
      role: 'assistant',
      content: message.trim(),
      timestamp: Date.now(),
    });

    await this.sessionsService.saveCampaignSession(session);

    // Also persist to DB
    await this.prisma.campaignPatient
      .update({
        where: { id: session.campaignPatientId },
        data: { messages: session.messages as any },
      })
      .catch(() => {
        this.logger.warn(`Failed to persist message to DB for ${phone}`);
      });

    this.logger.log(`Staff message sent to ${phone} via handoff`);
  }

  async resolveHandoff(phone: string): Promise<void> {
    const session = await this.sessionsService.getCampaignSession(phone);
    if (!session) {
      this.logger.warn(
        `resolveHandoff: no campaign session found for ${phone}`,
      );
      return;
    }

    if (
      session.status !== 'handed_off' &&
      session.status !== 'admin_handling'
    ) {
      this.logger.warn(
        `resolveHandoff: session ${phone} is "${session.status}" — not handed_off`,
      );
      return;
    }

    session.status = 'completed';
    await this.sessionsService.saveCampaignSession(session);

    this.logger.log(`Handoff resolved for ${phone}`);
  }
}
