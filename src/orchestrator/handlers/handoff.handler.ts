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
    // BUG 10: Handle follow-up messages when already in AWAITING_HANDOFF
    if (session.state === SessionState.AWAITING_HANDOFF) {
      // Follow-up: offer escape to menu
      const message = await this.botMessageService.getSafe(
        session.data.clinicId,
        MessageKey.HANDOFF_WAITING,
        {},
        session.data.language,
        'An agent will be with you shortly. Tap the button to return to the menu.',
      );
      const btnMenu = await this.botMessageService.getSafe(
        session.data.clinicId,
        MessageKey.BUTTON_MENU,
        {},
        session.data.language,
        'Menu',
      );
      await this.whatsappService.sendButtons(phone, message, [{ id: 'menu', title: btnMenu }]);
      return;
    }

    // First trigger: set state, notify user, alert boss
    session.state = SessionState.AWAITING_HANDOFF;
    await this.sessionsService.save(session);

    const message = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.HANDOFF_TRIGGERED,
      {},
      session.data.language,
      'Connecting you with our team. An agent will reply shortly.',
    );
    await this.whatsappService.sendText(phone, message);

    // FIX: BOSS_PHONE_NUMBER is read from env directly
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