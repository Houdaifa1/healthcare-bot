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

  /**
   * Called by IdleHandler when the user picks FAQ from the main menu.
   * Shows a prompt asking what the user wants to know — does NOT try to
   * parse the menu digit ("2") as a FAQ query.
   */
  async showFaqPrompt(phone: string, session: Session): Promise<void> {
    const lang = session.data.language;

    // Load all active FAQs and show them as a numbered list so user can pick
    const faqs = await this.faqService.findActive(session.data.clinicId, lang);

    if (faqs.length === 0) {
      const message = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.FAQ_NOT_FOUND,
        {},
        lang,
      );
      await this.whatsappService.sendButtons(phone, message, [
        { id: 'human_agent', title: '👤 Parler à un agent' },
        { id: 'menu', title: '↩️ Menu principal' },
      ]);
      return;
    }

    const intro = await this.botMessageService.get(
      session.data.clinicId,
      MessageKey.FAQ_INTRO,
      {},
      lang,
    );

    await this.whatsappService.sendInteractiveList(
      phone,
      intro,
      lang === 'FR' ? 'Questions fréquentes' : 'Frequently Asked Questions',
      lang === 'FR' ? 'Choisissez une question' : 'Choose a question',
      [
        {
          title: lang === 'FR' ? 'Questions' : 'Questions',
          rows: faqs.map((f, i) => ({
            id: `faq_${i + 1}`,
            title: f.question,
          })),
        },
      ],
    );
  }

  /**
   * Called by OrchestratorService when state is FAQ_BROWSING and a new
   * message arrives — the user is either picking a FAQ or asking a question.
   */
  async handle(phone: string, text: string, session: Session): Promise<void> {
    const lang = session.data.language;
    const trimmed = text.trim().toLowerCase();

    // ── FIX: Check escape inputs BEFORE intent detection ───────────────────
    // Numbered inputs in FAQ_BROWSING: "1" = pick FAQ, "2" = back to menu
    // The fallback intent only maps "2" → CANCEL in BOOKING_CONFIRM, not here.
    // Handle it explicitly so users are never trapped.
    if (trimmed === '2' || trimmed === 'menu' || trimmed === '↩️ menu principal' || trimmed === 'menu principal') {
      await this.goToMainMenu(phone, session);
      return;
    }

    if (trimmed === '1' || trimmed === '👤 parler à un agent') {
      await this.goToHandoff(phone, session, text);
      return;
    }

    // ── Check faq_N selection from interactive list ────────────────────────
    if (trimmed.startsWith('faq_')) {
      const index = parseInt(trimmed.replace('faq_', ''), 10);
      const faqs = await this.faqService.findActive(session.data.clinicId, lang);
      const faq = faqs[index - 1];
      if (faq) {
        await this.sendFaqAnswer(phone, session, faq.answer);
        return;
      }
    }

    // ── Check numbered selection ───────────────────────────────────────────
    const index = parseInt(trimmed, 10);
    if (!isNaN(index) && index >= 1) {
      const faqs = await this.faqService.findActive(session.data.clinicId, lang);
      const faq = faqs[index - 1];
      if (faq) {
        await this.sendFaqAnswer(phone, session, faq.answer);
        return;
      }
    }

    // ── Intent detection (only for free-text, after explicit checks) ───────
    const intent = await this.aiService.detectIntent(text, session.state, lang);

    if (intent === Intent.HUMAN_AGENT) {
      await this.goToHandoff(phone, session, text);
      return;
    }

    if (intent === Intent.CANCEL || intent === Intent.GREETING) {
      await this.goToMainMenu(phone, session);
      return;
    }

    if (intent === Intent.BOOK_APPOINTMENT) {
      await this.goToMainMenu(phone, session);
      return;
    }

    // ── FIX: keyword match on the raw text, not after intent reset ─────────
    const faq = await this.faqService.matchByKeywords(
      session.data.clinicId,
      text,
      lang,
    );

    if (faq) {
      await this.sendFaqAnswer(phone, session, faq.answer);
      return;
    }

    // ── No match found ──────────────────────────────────────────────────────
    const message = await this.botMessageService.get(
      session.data.clinicId,
      MessageKey.FAQ_NOT_FOUND,
      {},
      lang,
    );
    await this.whatsappService.sendButtons(phone, message, [
      { id: 'human_agent', title: '👤 Parler à un agent' },
      { id: 'menu', title: '↩️ Menu principal' },
    ]);
  }

  private async sendFaqAnswer(
    phone: string,
    session: Session,
    answer: string,
  ): Promise<void> {
    await this.whatsappService.sendText(phone, answer);

    // Show escape options after the answer so user knows what to do next
    const lang = session.data.language;
    const followUp = lang === 'FR'
      ? 'Autre chose ?'
      : 'Anything else?';

    await this.whatsappService.sendButtons(phone, followUp, [
      { id: 'human_agent', title: '👤 Parler à un agent' },
      { id: 'menu', title: '↩️ Menu principal' },
    ]);
  }

  private async goToMainMenu(phone: string, session: Session): Promise<void> {
    session.state = SessionState.IDLE;
    await this.sessionsService.save(session);

    // Fetch clinic name for welcome message
    const lang = session.data.language;
    const message = await this.botMessageService.get(
      session.data.clinicId,
      MessageKey.WELCOME,
      { clinicName: '' },
      lang,
    );
    await this.whatsappService.sendButtons(phone, message, [
      { id: 'book_appointment', title: '📅 Prendre RDV' },
      { id: 'faq', title: '❓ FAQ' },
      { id: 'human_agent', title: '👤 Parler à un agent' },
    ]);
  }

  private async goToHandoff(
    phone: string,
    session: Session,
    text: string,
  ): Promise<void> {
    session.state = SessionState.AWAITING_HANDOFF;
    await this.sessionsService.save(session);
    const message = await this.botMessageService.get(
      session.data.clinicId,
      MessageKey.HANDOFF_TRIGGERED,
      {},
      session.data.language,
    );
    await this.whatsappService.sendText(phone, message);
  }
}