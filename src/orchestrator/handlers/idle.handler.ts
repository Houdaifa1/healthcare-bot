import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { MessageKey, Language } from '@prisma/client';
import { SessionsService } from '../../sessions/sessions.service';
import { AiService, Intent } from '../../ai/ai.service';
import { LanguageDetectionService } from '../../bot-content/language-detection.service';
import { NameHandler } from './name.handler';
import { SpecialtyHandler } from './specialty.handler';
import { FaqHandler } from './faq.handler';
import { HandoffHandler } from './handoff.handler';
import { PrismaService } from '../../prisma/prisma.service';

// All button IDs used in the bot — these must NEVER be passed to language detection
// because they are English strings that would flip the session language.
const BUTTON_IDS = new Set([
  'book_appointment',
  'faq',
  'human_agent',
  'menu',
  'lang_fr',
  'lang_en',
  'confirm_yes',
  'confirm_no',
  'faq_list',
]);

const BUTTON_ID_PREFIXES = ['specialty_', 'doctor_', 'date_', 'time_', 'faq_'];

function isButtonId(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (BUTTON_IDS.has(lower)) return true;
  return BUTTON_ID_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

@Injectable()
export class IdleHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly botMessageService: BotMessageService,
    private readonly sessionsService: SessionsService,
    private readonly aiService: AiService,
    private readonly languageDetectionService: LanguageDetectionService,
    private readonly nameHandler: NameHandler,
    private readonly specialtyHandler: SpecialtyHandler,
    private readonly faqHandler: FaqHandler,
    private readonly handoffHandler: HandoffHandler,
    private readonly prisma: PrismaService,
  ) { }

  async handle(phone: string, text: string, session: Session): Promise<void> {
    const lower = text.trim().toLowerCase();

    // ── Direct button ID routing — no AI, no language detection ──────────
    // These must be checked first before anything else. Button IDs are English
    // strings and must never be passed to language or intent detection.
    if (lower === 'book_appointment') {
      if (session.data.patientName) {
        session.state = SessionState.BOOKING_SPECIALTY;
        await this.sessionsService.save(session);
        await this.specialtyHandler.showSpecialtyList(phone, session);
      } else {
        session.state = SessionState.AWAITING_NAME;
        await this.sessionsService.save(session);
        const message = await this.botMessageService.getSafe(
          session.data.clinicId, MessageKey.ASK_NAME, {}, session.data.language, 'What is your name?'
        );
        await this.whatsappService.sendText(phone, message);
      }
      return;
    }

    if (lower === 'faq') {
      session.state = SessionState.FAQ_BROWSING;
      await this.sessionsService.save(session);
      await this.faqHandler.showFaqPrompt(phone, session);
      return;
    }

    if (lower === 'human_agent') {
      await this.handoffHandler.handle(phone, text, session);
      return;
    }

    if (lower === 'menu') {
      session.state = SessionState.IDLE;
      session.data.languageConfirmed = false; // re-detect language on next free-text
      await this.sessionsService.save(session);
      await this.showWelcomeMenu(phone, session);
      return;
    }

    // ── Step 1: Detect language on first unconfirmed message ──────────────
    // Only run language detection on real free-text from the user,
    // never on button IDs (already handled above).
    if (!session.data.languageConfirmed) {
      const detected = await this.languageDetectionService.detect(
        text,
        session.data.language,
      );

      if (detected === null) {
        session.state = SessionState.LANGUAGE_SELECT;
        await this.sessionsService.save(session);
        const message = await this.botMessageService.getSafe(
          session.data.clinicId, MessageKey.LANGUAGE_PROMPT, {}, session.data.language, 'Choose your language:'
        );
        const btnFr = await this.botMessageService.getSafe(session.data.clinicId, MessageKey.BUTTON_FRENCH, {}, session.data.language, 'Français');
        const btnEn = await this.botMessageService.getSafe(session.data.clinicId, MessageKey.BUTTON_ENGLISH, {}, session.data.language, 'English');
        await this.whatsappService.sendButtons(phone, message, [
          { id: 'lang_fr', title: btnFr },
          { id: 'lang_en', title: btnEn },
        ]);
        return;
      }

      session.data.language = detected as Language;
      session.data.languageConfirmed = true;
      await this.sessionsService.save(session);
    }

    // ── Step 2: Detect intent via keyword fallback then AI ────────────────
    const intent = await this.aiService.detectIntent(
      text,
      session.state,
      session.data.language,
    );

    // ── Step 3: Route by intent ───────────────────────────────────────────
    if (intent === Intent.BOOK_APPOINTMENT) {
      if (session.data.patientName) {
        session.state = SessionState.BOOKING_SPECIALTY;
        await this.sessionsService.save(session);
        await this.specialtyHandler.showSpecialtyList(phone, session);
      } else {
        session.state = SessionState.AWAITING_NAME;
        await this.sessionsService.save(session);
        const message = await this.botMessageService.getSafe(
          session.data.clinicId, MessageKey.ASK_NAME, {}, session.data.language, 'What is your name?'
        );
        await this.whatsappService.sendText(phone, message);
      }
      return;
    }

    if (intent === Intent.ASK_FAQ) {
      session.state = SessionState.FAQ_BROWSING;
      await this.sessionsService.save(session);
      await this.faqHandler.showFaqPrompt(phone, session);
      return;
    }

    if (intent === Intent.HUMAN_AGENT) {
      await this.handoffHandler.handle(phone, text, session);
      return;
    }

    // GREETING, UNKNOWN, CANCEL — show welcome menu
    await this.showWelcomeMenu(phone, session);
  }

  async showWelcomeMenu(phone: string, session: Session): Promise<void> {
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

    const btnBook = await this.botMessageService.getSafe(session.data.clinicId, MessageKey.BUTTON_BOOK_APP, {}, session.data.language, 'Book appointment');
    const btnFaq = await this.botMessageService.getSafe(session.data.clinicId, MessageKey.BUTTON_FAQ, {}, session.data.language, 'FAQ');
    const btnAgent = await this.botMessageService.getSafe(session.data.clinicId, MessageKey.BUTTON_AGENT, {}, session.data.language, 'Talk to agent');
    await this.whatsappService.sendButtons(phone, message, [
      { id: 'book_appointment', title: btnBook },
      { id: 'faq', title: btnFaq },
      { id: 'human_agent', title: btnAgent },
    ]);
  }
}