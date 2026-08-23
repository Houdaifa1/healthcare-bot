import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { MessageKey } from '@prisma/client';
import { SessionsService } from '../../sessions/sessions.service';
import { AiService, Intent } from '../../ai/ai.service';
import { LanguageDetectionService } from '../../bot-content/language-detection.service';
import { SpecialtyHandler } from './specialty.handler';
import { FaqHandler } from './faq.handler';
import { HandoffHandler } from './handoff.handler';
import { WelcomeMenuService } from '../../bot-content/welcome-menu.service';
import { LanguagePromptService } from '../../bot-content/language-prompt.service';

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
    private readonly specialtyHandler: SpecialtyHandler,
    private readonly faqHandler: FaqHandler,
    private readonly handoffHandler: HandoffHandler,
    private readonly welcomeMenuService: WelcomeMenuService,
    private readonly languagePromptService: LanguagePromptService,
  ) { }

  async handle(phone: string, text: string, session: Session): Promise<void> {
    const lower = text.trim().toLowerCase();

    if (isButtonId(text)) {
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
        session.data.languageConfirmed = false;
        await this.sessionsService.save(session);
        await this.welcomeMenuService.show(phone, session);
        return;
      }

      await this.welcomeMenuService.show(phone, session);
      return;
    }

    if (!session.data.languageConfirmed) {
      const detected = await this.languageDetectionService.detect(text);

      if (detected === null) {
        session.state = SessionState.LANGUAGE_SELECT;
        await this.sessionsService.save(session);
        await this.languagePromptService.show(phone, session);
        return;
      }

      session.data.language = detected;
      session.data.languageConfirmed = true;
      await this.sessionsService.save(session);
    }

    const intent = await this.aiService.detectIntent(
      text,
      session.state,
      session.data.language,
    );

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

    await this.welcomeMenuService.show(phone, session);
  }
}
