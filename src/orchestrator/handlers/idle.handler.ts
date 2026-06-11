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
  ) {}

  async handle(phone: string, text: string, session: Session): Promise<void> {
    // ── Step 1: Detect language on first unconfirmed message ────────────────
    if (!session.data.languageConfirmed) {
      const detected = await this.languageDetectionService.detect(
        text,
        session.data.language,
      );

      if (detected === null) {
        session.state = SessionState.LANGUAGE_SELECT;
        await this.sessionsService.save(session);
        const message = await this.botMessageService.get(
          session.data.clinicId,
          MessageKey.LANGUAGE_PROMPT,
          {},
          session.data.language,
        );
        await this.whatsappService.sendButtons(phone, message, [
          { id: 'lang_fr', title: '🇫🇷 Français' },
          { id: 'lang_en', title: '🇬🇧 English' },
        ]);
        return;
      }

      session.data.language = detected as Language;
      session.data.languageConfirmed = true;
      await this.sessionsService.save(session);
    }

    // ── Step 2: Detect intent ───────────────────────────────────────────────
    const intent = await this.aiService.detectIntent(
      text,
      session.state,
      session.data.language,
    );

    // ── Step 3: Route by intent ─────────────────────────────────────────────
    if (intent === Intent.BOOK_APPOINTMENT) {
      if (session.data.patientName) {
        session.state = SessionState.BOOKING_SPECIALTY;
        await this.sessionsService.save(session);
        await this.specialtyHandler.showSpecialtyList(phone, session);
      } else {
        session.state = SessionState.AWAITING_NAME;
        await this.sessionsService.save(session);
        const message = await this.botMessageService.get(
          session.data.clinicId,
          MessageKey.ASK_NAME,
          {},
          session.data.language,
        );
        await this.whatsappService.sendText(phone, message);
      }
      return;
    }

    if (intent === Intent.ASK_FAQ) {
      session.state = SessionState.FAQ_BROWSING;
      await this.sessionsService.save(session);
      // FIX: do NOT pass the menu digit as FAQ query — show the FAQ prompt instead
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
    // FIX: fetch real clinic name from DB instead of hardcoding empty string
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: session.data.clinicId },
      select: { name: true },
    });

    const message = await this.botMessageService.get(
      session.data.clinicId,
      MessageKey.WELCOME,
      { clinicName: clinic?.name ?? '' },
      session.data.language,
    );

    await this.whatsappService.sendButtons(phone, message, [
      { id: 'book_appointment', title: '📅 Prendre RDV' },
      { id: 'faq', title: '❓ FAQ' },
      { id: 'human_agent', title: '👤 Parler à un agent' },
    ]);
  }
}