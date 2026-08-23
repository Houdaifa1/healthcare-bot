import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionsService } from '../../sessions/sessions.service';
import { FAQService } from '../../bot-content/faq.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { MessageKey } from '@prisma/client';
import { AiService, Intent } from '../../ai/ai.service';
import { WelcomeMenuService } from '../../bot-content/welcome-menu.service';

@Injectable()
export class FaqHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly faqService: FAQService,
    private readonly botMessageService: BotMessageService,
    private readonly aiService: AiService,
    private readonly welcomeMenuService: WelcomeMenuService,
  ) { }

  /**
   * Called by IdleHandler when the user picks FAQ from the main menu.
   * Shows the full FAQ list as an interactive list with a select button.
   */
  async showFaqPrompt(phone: string, session: Session): Promise<void> {
    const lang = session.data.language;
    const clinicId = session.data.clinicId;

    // Load all active FAQs
    const faqs = await this.faqService.findActive(clinicId, lang);

    if (faqs.length === 0) {
      const [message, btnMenu] = await Promise.all([
        this.botMessageService.getSafe(clinicId, MessageKey.FAQ_NOT_FOUND, {}, lang, 'No FAQs available.'),
        this.botMessageService.getSafe(clinicId, MessageKey.BUTTON_MENU, {}, lang, 'Menu'),
      ]);
      await this.whatsappService.sendButtons(phone, message, [
        { id: 'menu', title: btnMenu },
      ]);
      return;
    }

    const [header, body, buttonLabel] = await Promise.all([
      this.botMessageService.getSafe(clinicId, MessageKey.FAQ_INTRO, {}, lang, 'Frequently Asked Questions'),
      this.botMessageService.getSafe(clinicId, MessageKey.FAQ_LIST_PROMPT, {}, lang, 'Select a question:'),
      this.botMessageService.getSafe(clinicId, MessageKey.HEADER_SELECT_FAQ, {}, lang, 'View questions'),
    ]);

    // Split FAQs into sections of max 10 rows (Meta limit)
    const rows = faqs.map((f, i) => ({
      id: `faq_${i + 1}`,
      title: f.question.length > 24 ? f.question.substring(0, 21) + '...' : f.question,
      description: undefined,
    }));

    await this.whatsappService.sendInteractiveList(
      phone,
      header,
      body,
      buttonLabel,
      [
        {
          title: header.slice(0, 24),
          rows,
        },
      ],
    );
  }

  /**
   * Called by OrchestratorService when state is FAQ_BROWSING.
   */
  async handle(phone: string, text: string, session: Session): Promise<void> {
    const lang = session.data.language;
    const clinicId = session.data.clinicId;
    const trimmed = text.trim().toLowerCase();

    // ── Button ID routing ────────────────────────────────────────────────
    if (trimmed === 'menu') {
      await this.goToMainMenu(phone, session);
      return;
    }

    if (trimmed === 'faq_list') {
      // User wants to go back to the FAQ list
      await this.showFaqPrompt(phone, session);
      return;
    }

    // ── Check faq_N selection from interactive list ───────────────────────
    if (trimmed.startsWith('faq_')) {
      const index = parseInt(trimmed.replace('faq_', ''), 10);
      const faqs = await this.faqService.findActive(clinicId, lang);
      const faq = faqs[index - 1];
      if (faq) {
        await this.sendFaqAnswer(phone, session, faq.answer, faqs.length > 1);
        return;
      }
    }

    // ── Check numbered selection (backwards compat) ──────────────────────
    const index = parseInt(trimmed, 10);
    if (!isNaN(index) && index >= 1) {
      const faqs = await this.faqService.findActive(clinicId, lang);
      const faq = faqs[index - 1];
      if (faq) {
        await this.sendFaqAnswer(phone, session, faq.answer, faqs.length > 1);
        return;
      }
    }

    // ── Intent detection (for free-text) ──────────────────────────────────
    const intent = await this.aiService.detectIntent(text, session.state, lang);

    if (intent === Intent.CANCEL || intent === Intent.GREETING || intent === Intent.BOOK_APPOINTMENT) {
      await this.goToMainMenu(phone, session);
      return;
    }

    // ── Keyword match on the raw text ─────────────────────────────────────
    const faq = await this.faqService.matchByKeywords(clinicId, text, lang);
    if (faq) {
      const allFaqs = await this.faqService.findActive(clinicId, lang);
      await this.sendFaqAnswer(phone, session, faq.answer, allFaqs.length > 1);
      return;
    }

    // ── Semantic AI matching before "not found" ───────────────────────────
    const allFaqs = await this.faqService.findActive(clinicId, lang);
    if (allFaqs.length > 0) {
      const aiFaqId = await this.aiService.matchFaq(
        text,
        allFaqs.map((f) => ({ id: f.id, question: f.question })),
        lang,
      );
      if (aiFaqId) {
        const matchedFaq = allFaqs.find((f) => f.id === aiFaqId);
        if (matchedFaq) {
          await this.sendFaqAnswer(phone, session, matchedFaq.answer, allFaqs.length > 1);
          return;
        }
      }
    }

    // ── No match found — return to FAQ list ───────────────────────────────
    const [notFound, btnFaqList, btnMenu] = await Promise.all([
      this.botMessageService.getSafe(clinicId, MessageKey.FAQ_NOT_FOUND, {}, lang, 'I could not find an answer.'),
      this.botMessageService.getSafe(clinicId, MessageKey.BUTTON_FAQ_LIST, {}, lang, 'Back to questions'),
      this.botMessageService.getSafe(clinicId, MessageKey.BUTTON_MENU, {}, lang, 'Menu'),
    ]);
    await this.whatsappService.sendButtons(phone, notFound, [
      { id: 'faq_list', title: btnFaqList },
      { id: 'menu', title: btnMenu },
    ]);
  }

  private async sendFaqAnswer(
    phone: string,
    session: Session,
    answer: string,
    hasMoreFaqs: boolean,
  ): Promise<void> {
    await this.whatsappService.sendText(phone, answer);

    // Show follow-up buttons: Back to FAQ list + Menu
    const lang = session.data.language;
    const clinicId = session.data.clinicId;
    const followUp = await this.botMessageService.getSafe(clinicId, MessageKey.FAQ_FOLLOW_UP, {}, lang, 'Anything else?');

    if (hasMoreFaqs) {
      const [btnFaqList, btnMenu] = await Promise.all([
        this.botMessageService.getSafe(clinicId, MessageKey.BUTTON_FAQ_LIST, {}, lang, 'More questions'),
        this.botMessageService.getSafe(clinicId, MessageKey.BUTTON_MENU, {}, lang, 'Menu'),
      ]);
      await this.whatsappService.sendButtons(phone, followUp, [
        { id: 'faq_list', title: btnFaqList },
        { id: 'menu', title: btnMenu },
      ]);
    } else {
      const btnMenu = await this.botMessageService.getSafe(clinicId, MessageKey.BUTTON_MENU, {}, lang, 'Menu');
      await this.whatsappService.sendButtons(phone, followUp, [
        { id: 'menu', title: btnMenu },
      ]);
    }
  }

  private async goToMainMenu(phone: string, session: Session): Promise<void> {
    session.state = SessionState.IDLE;
    session.data.languageConfirmed = false; // re-detect language on next message
    await this.sessionsService.save(session);
    await this.welcomeMenuService.show(phone, session);
  }
}