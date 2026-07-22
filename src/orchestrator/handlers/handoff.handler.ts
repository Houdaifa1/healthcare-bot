import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionsService } from '../../sessions/sessions.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { MessageKey } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class HandoffHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly botMessageService: BotMessageService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async handle(phone: string, text: string, session: Session): Promise<void> {
    if (session.state === SessionState.AWAITING_HANDOFF) {
      // User tapped Menu button — escape handoff, reset to IDLE
      if (text.trim().toLowerCase() === 'menu') {
        session.state = SessionState.IDLE;
        session.data.languageConfirmed = false;
        await this.sessionsService.save(session);
        await this.showWelcomeMenu(phone, session);
        return;
      }

      // Any other follow-up message — remind them and show menu button
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
      await this.whatsappService.sendButtons(phone, message, [
        { id: 'menu', title: btnMenu },
      ]);
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

  private async showWelcomeMenu(
    phone: string,
    session: Session,
  ): Promise<void> {
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: session.data.clinicId },
      select: { name: true },
    });

    const message = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.WELCOME,
      { clinicName: clinic?.name ?? '' },
      session.data.language,
      'Welcome! How can I help you?',
    );

    const btnBook = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.BUTTON_BOOK_APP,
      {},
      session.data.language,
      'Book appointment',
    );
    const btnFaq = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.BUTTON_FAQ,
      {},
      session.data.language,
      'FAQ',
    );
    const btnAgent = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.BUTTON_AGENT,
      {},
      session.data.language,
      'Talk to agent',
    );
    await this.whatsappService.sendButtons(phone, message, [
      { id: 'book_appointment', title: btnBook },
      { id: 'faq', title: btnFaq },
      { id: 'human_agent', title: btnAgent },
    ]);
  }
}
