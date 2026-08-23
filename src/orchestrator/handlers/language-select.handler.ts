import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { Language } from '@prisma/client';
import { SessionsService } from '../../sessions/sessions.service';
import { WelcomeMenuService } from '../../bot-content/welcome-menu.service';
import { LanguagePromptService } from '../../bot-content/language-prompt.service';

@Injectable()
export class LanguageSelectHandler {
  constructor(
    private readonly sessionsService: SessionsService,
    private readonly welcomeMenuService: WelcomeMenuService,
    private readonly languagePromptService: LanguagePromptService,
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
      await this.welcomeMenuService.show(phone, session);
      return;
    }

    if (isEN) {
      session.data.language = Language.EN;
      session.data.languageConfirmed = true;
      session.state = SessionState.IDLE;
      await this.sessionsService.save(session);
      await this.welcomeMenuService.show(phone, session);
      return;
    }

    // Ambiguous — ask again
    await this.languagePromptService.show(phone, session);
  }
}