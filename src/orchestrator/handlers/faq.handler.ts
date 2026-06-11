import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionsService } from '../../sessions/sessions.service';
import { FAQService } from '../../bot-content/faq.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { MessageKey } from '@prisma/client';
import { AiService, Intent } from '../../ai/ai.service';

@Injectable()
export class FaqHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly faqService: FAQService,
    private readonly botMessageService: BotMessageService,
    private readonly aiService: AiService,
  ) {}

  async handle(phone: string, text: string, session: Session): Promise<void> {
    // ── Check escape intents first, before attempting FAQ match ────────────
    const intent = await this.aiService.detectIntent(
      text,
      session.state,
      session.data.language,
    );

    // User wants a human agent
    if (intent === Intent.HUMAN_AGENT) {
      session.state = SessionState.AWAITING_HANDOFF;
      await this.sessionsService.save(session);
      // Import-cycle safe: re-use the bot message and notify
      const message = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.HANDOFF_TRIGGERED,
        {},
        session.data.language,
      );
      await this.whatsappService.sendText(phone, message);
      return;
    }

    // User wants to go back to the main menu (CANCEL intent or explicit "menu")
    if (
      intent === Intent.CANCEL ||
      intent === Intent.GREETING ||
      intent === Intent.BOOK_APPOINTMENT
    ) {
      session.state = SessionState.IDLE;
      await this.sessionsService.save(session);

      // If they specifically want to book, let idle handler route them directly
      if (intent === Intent.BOOK_APPOINTMENT) {
        // Lazy-load to avoid circular dependency — handled via the orchestrator
        // so we just reset and send the welcome menu; their next message routes properly
        const message = await this.botMessageService.get(
          session.data.clinicId,
          MessageKey.WELCOME,
          { clinicName: '' },
          session.data.language,
        );
        await this.whatsappService.sendButtons(phone, message, [
          { id: 'book_appointment', title: '📅 Prendre RDV' },
          { id: 'faq', title: '❓ FAQ' },
          { id: 'human_agent', title: '👤 Parler à un agent' },
        ]);
        return;
      }

      // Greeting or cancel — just show welcome menu
      const message = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.WELCOME,
        { clinicName: '' },
        session.data.language,
      );
      await this.whatsappService.sendButtons(phone, message, [
        { id: 'book_appointment', title: '📅 Prendre RDV' },
        { id: 'faq', title: '❓ FAQ' },
        { id: 'human_agent', title: '👤 Parler à un agent' },
      ]);
      return;
    }

    // ── Attempt FAQ keyword match ───────────────────────────────────────────
    const faq = await this.faqService.matchByKeywords(
      session.data.clinicId,
      text,
      session.data.language,
    );

    if (faq) {
      await this.whatsappService.sendText(phone, faq.answer);
      // Stay in FAQ_BROWSING so user can ask follow-up questions
      // but show the escape options so they know how to leave
      const followUp = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.FAQ_NOT_FOUND,
        {},
        session.data.language,
      );
      await this.whatsappService.sendButtons(phone, followUp, [
        { id: 'human_agent', title: '👤 Parler à un agent' },
        { id: 'menu', title: '↩️ Menu principal' },
      ]);
      return;
    }

    // ── No match found ──────────────────────────────────────────────────────
    const message = await this.botMessageService.get(
      session.data.clinicId,
      MessageKey.FAQ_NOT_FOUND,
      {},
      session.data.language,
    );
    await this.whatsappService.sendButtons(phone, message, [
      { id: 'human_agent', title: '👤 Parler à un agent' },
      { id: 'menu', title: '↩️ Menu principal' },
    ]);
  }
}