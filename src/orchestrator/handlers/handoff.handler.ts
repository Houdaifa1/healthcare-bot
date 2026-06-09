import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionsService } from '../../sessions/sessions.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { MessageKey } from '@prisma/client';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class HandoffHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly botMessageService: BotMessageService,
    private readonly configService: ConfigService,
  ) {}

  async handle(phone: string, text: string, session: Session): Promise<void> {
    session.state = SessionState.AWAITING_HANDOFF;
    await this.sessionsService.save(session);

    const message = await this.botMessageService.get(
      session.data.clinicId,
      MessageKey.HANDOFF_TRIGGERED,
      {},
      session.data.language,
    );
    await this.whatsappService.sendText(phone, message);

    const bossPhoneNumber = this.configService.get<string>('BOSS_PHONE_NUMBER');
    if (bossPhoneNumber) {
      const alert =
        `🔔 Handoff Alert\n` +
        `Patient: ${session.data.patientName || 'Unknown'}\n` +
        `Phone: ${phone}\n` +
        `Last message: "${text}"\n` +
        `Time: ${new Date().toLocaleString()}`;
      await this.whatsappService.sendText(bossPhoneNumber, alert);
    }
  }
}