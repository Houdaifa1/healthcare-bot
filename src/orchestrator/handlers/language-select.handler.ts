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
    const normalizedText = text.toLowerCase();

    if (normalizedText.includes('fr') || normalizedText.includes('lang_fr')) {
      session.data.language = Language.FR;
      session.data.languageConfirmed = true;
      session.state = SessionState.IDLE;
      await this.sessionsService.save(session);
      await this.idleHandler.handle(phone, text, session);
      return;
    }

    if (normalizedText.includes('en') || normalizedText.includes('lang_en')) {
      session.data.language = Language.EN;
      session.data.languageConfirmed = true;
      session.state = SessionState.IDLE;
      await this.sessionsService.save(session);
      await this.idleHandler.handle(phone, text, session);
      return;
    }

    // Ambiguous — ask again
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
  }
}