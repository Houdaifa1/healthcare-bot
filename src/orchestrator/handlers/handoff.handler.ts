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

    // FIX: BOSS_PHONE_NUMBER is not a nested config key — read from env directly
    const bossPhone = process.env.BOSS_PHONE_NUMBER;
    if (bossPhone) {
      // Normalise to JID format expected by Baileys
      const bossJid = bossPhone.replace(/^\+/, '') + '@s.whatsapp.net';
      const alert =
        `🔔 *Handoff Alert*\n` +
        `👤 Patient: ${session.data.patientName ?? 'Unknown'}\n` +
        `📱 Phone: ${phone}\n` +
        `💬 Last message: "${text}"\n` +
        `🕐 Time: ${new Date().toLocaleString('fr-MA', { timeZone: 'Africa/Casablanca' })}`;
      await this.whatsappService.sendText(bossJid, alert);
    }
  }
}