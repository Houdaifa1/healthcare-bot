import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SessionsService } from '../sessions/sessions.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { BotMessageService } from '../bot-content/bot-message.service';
import { Session, SessionState } from '../sessions/sessions.service';

type MessageKey = 'WELCOME' | 'LANGUAGE_PROMPT' | 'ASK_NAME' | 'SELECT_SPECIALTY' | 'SELECT_DOCTOR' | 'SELECT_DATE' | 'SELECT_TIME' | 'CONFIRM_BOOKING' | 'BOOKING_SUCCESS' | 'BOOKING_CANCELLED' | 'FAQ_INTRO' | 'FAQ_NOT_FOUND' | 'FALLBACK' | 'HANDOFF_TRIGGERED' | 'SESSION_EXPIRED' | 'NO_SLOTS_AVAILABLE' | 'OUTSIDE_HOURS';

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
      'HANDOFF_TRIGGERED' as MessageKey,
      {},
      session.data.language,
    );
    await this.whatsappService.sendText(session.phone, handoffMessage);

    // Alert the admin via WhatsApp
    const bossPhone = this.configService.get<string>('whatsapp.bossPhone');
    if (bossPhone) {
      const alertMessage = `🔔 Handoff Alert\nPatient: ${session.data.patientName || 'Unknown'}\nPhone: ${session.phone}\nTime: ${new Date().toISOString()}`;
      await this.whatsappService.sendText(bossPhone, alertMessage);
      this.logger.log(`Handoff alert sent to ${bossPhone}`);
    }
  }

  async handleHandoffMessage(session: Session, message: string): Promise<void> {
    this.logger.log(
      `Handoff message from user ${session.phone}: ${message}. Awaiting agent response.`,
    );
  }

  async getHandoffSessions(): Promise<{ phone: string; state: string; patientName?: string; lastMessage?: string; updatedAt: number }[]> {
    // Session keys are stored as session:<phone> in Redis
    // We use the SessionsService's Redis connection to scan for AWAITING_HANDOFF sessions
    try {
      const keys = await this.sessionsService.scanKeys();
      const sessions: { phone: string; state: string; patientName?: string; lastMessage?: string; updatedAt: number }[] = [];
      for (const key of keys) {
        const phone = key.replace('session:', '');
        const session = await this.sessionsService.getOrCreate(phone, '', 'FR' as any);
        if (session.state === SessionState.AWAITING_HANDOFF) {
          sessions.push({
            phone,
            state: session.state,
            patientName: session.data.patientName,
            updatedAt: session.updatedAt,
          });
        }
      }
      return sessions;
    } catch (error) {
      this.logger.error('Failed to scan handoff sessions', error);
      return [];
    }
  }

  async resolveHandoff(phone: string): Promise<void> {
    const cleanPhone = phone.replace(/@(lid|s\.whatsapp\.net)$/, '');
    const session = await this.sessionsService.getOrCreate(cleanPhone, '', 'FR' as any);
    if (!session || session.state !== SessionState.AWAITING_HANDOFF) {
      this.logger.warn(
        `Cannot resolve handoff for session ${phone} which is not in a handoff state.`,
      );
      return;
    }

    this.logger.log(`Resolving handoff for session: ${phone}`);
    session.state = SessionState.IDLE;
    await this.sessionsService.save(session);
  }
}