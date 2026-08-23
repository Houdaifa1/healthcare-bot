import { Injectable } from '@nestjs/common';
import { MessageKey } from '@prisma/client';
import { Session } from '../sessions/sessions.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { BotMessageService } from './bot-message.service';

@Injectable()
export class LanguagePromptService {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly botMessageService: BotMessageService,
  ) {}

  async show(phone: string, session: Session): Promise<void> {
    const [message, btnFr, btnEn] = await Promise.all([
      this.botMessageService.getSafe(session.data.clinicId, MessageKey.LANGUAGE_PROMPT, {}, session.data.language, 'Choose your language:'),
      this.botMessageService.getSafe(session.data.clinicId, MessageKey.BUTTON_FRENCH, {}, session.data.language, 'Français'),
      this.botMessageService.getSafe(session.data.clinicId, MessageKey.BUTTON_ENGLISH, {}, session.data.language, 'English'),
    ]);

    await this.whatsappService.sendButtons(phone, message, [
      { id: 'lang_fr', title: btnFr },
      { id: 'lang_en', title: btnEn },
    ]);
  }
}
