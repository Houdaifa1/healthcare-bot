import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { MessageKey, Language } from '@prisma/client';
import { SessionsService } from '../../sessions/sessions.service';
import { IdleHandler } from './idle.handler';

@Injectable()
export class LanguageSelectHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly botMessageService: BotMessageService,
    private readonly sessionsService: SessionsService,
    private readonly idleHandler: IdleHandler,
  ) {}

  async handle(phone: string, text: string, session: Session): Promise<void> {
    const trimmed = text.trim().toLowerCase();

    // ── Exact match only — NEVER use includes() here.
    // includes('fr') would match "confirmer", "offrir", etc.
    // includes('en') would match "rendez-vous", "prendre", "bien", etc.
    // Button IDs are 'lang_fr' and 'lang_en' — match those plus the display labels.
    const isFR =
      trimmed === 'lang_fr' ||
      trimmed === '🇫🇷 français' ||
      trimmed === 'français' ||
      trimmed === 'francais' ||
      trimmed === 'fr';

    const isEN =
      trimmed === 'lang_en' ||
      trimmed === '🇬🇧 english' ||
      trimmed === 'english' ||
      trimmed === 'en';

    if (isFR) {
      session.data.language = Language.FR;
      session.data.languageConfirmed = true;
      session.state = SessionState.IDLE;
      await this.sessionsService.save(session);
      await this.idleHandler.showWelcomeMenu(phone, session);
      return;
    }

    if (isEN) {
      session.data.language = Language.EN;
      session.data.languageConfirmed = true;
      session.state = SessionState.IDLE;
      await this.sessionsService.save(session);
      await this.idleHandler.showWelcomeMenu(phone, session);
      return;
    }

    // Ambiguous — ask again
    const message = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.LANGUAGE_PROMPT,
      {},
      session.data.language,
      'Choose your language:',
    );
    const btnFr = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.BUTTON_FRENCH,
      {},
      session.data.language,
      'Français',
    );
    const btnEn = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.BUTTON_ENGLISH,
      {},
      session.data.language,
      'English',
    );
    await this.whatsappService.sendButtons(phone, message, [
      { id: 'lang_fr', title: btnFr },
      { id: 'lang_en', title: btnEn },
    ]);
  }
}
