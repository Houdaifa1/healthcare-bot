import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionsService } from '../../sessions/sessions.service';
import { FAQService } from '../../bot-content/faq.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { MessageKey } from '@prisma/client';
import { AiService, Intent } from '../../ai/ai.service';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class FaqHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly faqService: FAQService,
    private readonly botMessageService: BotMessageService,
    private readonly aiService: AiService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Called by IdleHandler when the user picks FAQ from the main menu.
   * Shows the full FAQ list from DB as numbered options.
   */
  async showFaqPrompt(phone: string, session: Session): Promise<void> {
    const lang = session.data.language;
    const clinicId = session.data.clinicId;

    // Load all active FAQs
    const faqs = await this.faqService.findActive(clinicId, lang);

    if (faqs.length === 0) {
      const message = await this.botMessageService.get(clinicId, MessageKey.FAQ_NOT_FOUND, {}, lang);
      const btnAgent = await this.botMessageService.get(clinicId, MessageKey.BUTTON_AGENT, {}, lang);
      const btnMenu = await this.botMessageService.get(clinicId, MessageKey.BUTTON_MENU, {}, lang);
      await this.whatsappService.sendButtons(phone, message, [
        { id: 'human_agent', title: btnAgent },
        { id: 'menu', title: btnMenu },
      ]);
      return;
    }

    const intro = await this.botMessageService.get(clinicId, MessageKey.FAQ_INTRO, {}, lang);
    const prompt = await this.botMessageService.get(clinicId, MessageKey.FAQ_LIST_PROMPT, {}, lang);

    // Send intro text first
    await this.whatsappService.sendText(phone, intro);

    // Build numbered list
    const faqLines = faqs.map((f, i) => `${i + 1}. ${f.question}`).join('\n');
    const numberedList = `${faqLines}\n\n${prompt}`;

    const btnMenu = await this.botMessageService.get(clinicId, MessageKey.BUTTON_MENU, {}, lang);
    const btnAgent = await this.botMessageService.get(clinicId, MessageKey.BUTTON_AGENT, {}, lang);
    await this.whatsappService.sendButtons(phone, numberedList, [
      { id: 'menu', title: btnMenu },
      { id: 'human_agent', title: btnAgent },
    ]);
  }

  /**
   * Called by OrchestratorService when state is FAQ_BROWSING.
   */
  async handle(phone: string, text: string, session: Session): Promise<void> {
    const lang = session.data.language;
    const clinicId = session.data.clinicId;
    const trimmed = text.trim().toLowerCase();

    // ── Escape checks — user must never be trapped in FAQ state ───────────
    if (trimmed === 'menu' || trimmed === '↩️ menu principal' || trimmed === 'main menu' || trimmed === '↩️ main menu') {
      await this.goToMainMenu(phone, session);
      return;
    }

    // ── Check faq_N selection from interactive list ───────────────────────
    if (trimmed.startsWith('faq_')) {
      const index = parseInt(trimmed.replace('faq_', ''), 10);
      const faqs = await this.faqService.findActive(clinicId, lang);
      const faq = faqs[index - 1];
      if (faq) {
        await this.sendFaqAnswer(phone, session, faq.answer);
        return;
      }
    }

    // ── Check numbered selection ──────────────────────────────────────────
    const index = parseInt(trimmed, 10);
    if (!isNaN(index) && index >= 1) {
      const faqs = await this.faqService.findActive(clinicId, lang);
      const faq = faqs[index - 1];
      if (faq) {
        await this.sendFaqAnswer(phone, session, faq.answer);
        return;
      }
    }

    // ── Intent detection (for free-text after explicit checks) ────────────
    const intent = await this.aiService.detectIntent(text, session.state, lang);

    if (intent === Intent.HUMAN_AGENT) {
      await this.goToHandoff(phone, session, text);
      return;
    }

    if (intent === Intent.CANCEL || intent === Intent.GREETING || intent === Intent.BOOK_APPOINTMENT) {
      await this.goToMainMenu(phone, session);
      return;
    }

    // ── Keyword match on the raw text ─────────────────────────────────────
    const faq = await this.faqService.matchByKeywords(clinicId, text, lang);
    if (faq) {
      await this.sendFaqAnswer(phone, session, faq.answer);
      return;
    }

    // ── No match found — show buttons with escape options ─────────────────
    const notFound = await this.botMessageService.get(clinicId, MessageKey.FAQ_NOT_FOUND, {}, lang);
    const btnAgent = await this.botMessageService.get(clinicId, MessageKey.BUTTON_AGENT, {}, lang);
    const btnMenu = await this.botMessageService.get(clinicId, MessageKey.BUTTON_MENU, {}, lang);
    await this.whatsappService.sendButtons(phone, notFound, [
      { id: 'human_agent', title: btnAgent },
      { id: 'menu', title: btnMenu },
    ]);
  }

  private async sendFaqAnswer(phone: string, session: Session, answer: string): Promise<void> {
    await this.whatsappService.sendText(phone, answer);

    // Show follow-up with DB-driven button labels
    const lang = session.data.language;
    const clinicId = session.data.clinicId;
    const followUp = await this.botMessageService.get(clinicId, MessageKey.FAQ_FOLLOW_UP, {}, lang);
    const btnAgent = await this.botMessageService.get(clinicId, MessageKey.BUTTON_AGENT, {}, lang);
    const btnMenu = await this.botMessageService.get(clinicId, MessageKey.BUTTON_MENU, {}, lang);
    await this.whatsappService.sendButtons(phone, followUp, [
      { id: 'human_agent', title: btnAgent },
      { id: 'menu', title: btnMenu },
    ]);
  }

  private async goToMainMenu(phone: string, session: Session): Promise<void> {
    session.state = SessionState.IDLE;
    await this.sessionsService.save(session);

    const lang = session.data.language;
    const clinicId = session.data.clinicId;

    // Fetch clinic name for welcome message
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { name: true },
    });

    const message = await this.botMessageService.get(clinicId, MessageKey.WELCOME, { clinicName: clinic?.name ?? '' }, lang);
    const btnBook = await this.botMessageService.get(clinicId, MessageKey.BUTTON_BOOK_APP, {}, lang);
    const btnFaq = await this.botMessageService.get(clinicId, MessageKey.BUTTON_FAQ, {}, lang);
    const btnAgent = await this.botMessageService.get(clinicId, MessageKey.BUTTON_AGENT, {}, lang);
    await this.whatsappService.sendButtons(phone, message, [
      { id: 'book_appointment', title: btnBook },
      { id: 'faq', title: btnFaq },
      { id: 'human_agent', title: btnAgent },
    ]);
  }

  private async goToHandoff(phone: string, session: Session, text: string): Promise<void> {
    session.state = SessionState.AWAITING_HANDOFF;
    await this.sessionsService.save(session);
    const message = await this.botMessageService.get(session.data.clinicId, MessageKey.HANDOFF_TRIGGERED, {}, session.data.language);
    await this.whatsappService.sendText(phone, message);
  }
}