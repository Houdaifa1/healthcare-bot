import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SessionsService } from '../sessions/sessions.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { BotMessageService } from '../bot-content/bot-message.service';
import { Session, SessionState } from '../sessions/sessions.service';
import { MessageKey } from '@prisma/client';

@Injectable()
export class HandoffService {
  private readonly logger = new Logger(HandoffService.name);

  constructor(
    private readonly sessionsService: SessionsService,
    private readonly whatsappService: WhatsAppService,
    private readonly botMessageService: BotMessageService,
    private readonly configService: ConfigService,
  ) {}

  async initiateHandoff(session: Session): Promise<void> {
    this.logger.log(`Initiating handoff for session: ${session.phone}`);
    session.state = SessionState.AWAITING_HANDOFF;
    await this.sessionsService.save(session);

    const handoffMessage = await this.botMessageService.get(
      session.data.clinicId,
      MessageKey.HANDOFF_TRIGGERED,
      {},
      session.data.language,
    );
    await this.whatsappService.sendText(session.phone, handoffMessage);

    const bossPhone = this.configService.get<string>('whatsapp.bossPhone');
    if (bossPhone) {
      const alertMessage =
        `🔔 Handoff Alert\nPatient: ${session.data.patientName ?? 'Unknown'}\n` +
        `Phone: ${session.phone}\nTime: ${new Date().toISOString()}`;
      await this.whatsappService.sendText(bossPhone, alertMessage);
      this.logger.log(`Handoff alert sent to ${bossPhone}`);
    }
  }

  async handleHandoffMessage(session: Session, message: string): Promise<void> {
    this.logger.log(
      `Handoff message from user ${session.phone}: "${message}". Awaiting agent response.`,
    );
  }

  /**
   * Returns all reactive sessions currently in AWAITING_HANDOFF state.
   *
   * Uses raw Redis GET via getClient() — never calls getOrCreate(), which
   * would create phantom sessions with empty clinicId for non-existent phones.
   */
  async getHandoffSessions(): Promise<
    { phone: string; state: string; patientName?: string; updatedAt: number }[]
  > {
    const redis = this.sessionsService.getClient();

    let keys: string[];
    try {
      keys = await this.sessionsService.scanKeys();
    } catch (error) {
      this.logger.error('Failed to scan session keys', error);
      return [];
    }

    const results: { phone: string; state: string; patientName?: string; updatedAt: number }[] = [];

    for (const key of keys) {
      try {
        const raw = await redis.get(key);
        if (!raw) continue;

        const session = JSON.parse(raw) as Session;
        if (session.state !== SessionState.AWAITING_HANDOFF) continue;

        // Derive phone from key — key format is "session:<phone>"
        const phone = key.replace(/^session:/, '');

        results.push({
          phone,
          state:       session.state,
          patientName: session.data?.patientName,
          updatedAt:   session.updatedAt,
        });
      } catch (err) {
        this.logger.warn(`Failed to read session key "${key}"`, err);
      }
    }

    return results;
  }

  /**
   * Resolves a handoff session back to IDLE and notifies the patient.
   *
   * Uses raw Redis GET via getClient() — never calls getOrCreate() so we
   * cannot accidentally create or corrupt an existing session.
   */
  async resolveHandoff(phone: string): Promise<void> {
    const redis = this.sessionsService.getClient();
    const key   = `session:${phone}`;

    let session: Session;
    try {
      const raw = await redis.get(key);
      if (!raw) {
        this.logger.warn(`resolveHandoff: no session found for ${phone}`);
        return;
      }
      session = JSON.parse(raw) as Session;
    } catch (err) {
      this.logger.error(`resolveHandoff: failed to read session for ${phone}`, err);
      return;
    }

    if (session.state !== SessionState.AWAITING_HANDOFF) {
      this.logger.warn(
        `resolveHandoff: session ${phone} is in state "${session.state}", not AWAITING_HANDOFF — skipping`,
      );
      return;
    }

    this.logger.log(`Resolving handoff for session: ${phone}`);
    session.state = SessionState.IDLE;
    await this.sessionsService.save(session);

    try {
      const resolvedMessage = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.HANDOFF_RESOLVED,
        {},
        session.data.language,
      );
      await this.whatsappService.sendText(phone, resolvedMessage);
    } catch (err) {
      this.logger.warn(`resolveHandoff: failed to send resolution message to ${phone}`, err);
    }
  }
}