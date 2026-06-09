import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionsService } from '../../sessions/sessions.service';
import { FAQService } from '../../bot-content/faq.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { MessageKey } from '@prisma/client';

@Injectable()
export class FaqHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly faqService: FAQService,
    private readonly botMessageService: BotMessageService,
  ) {}

  async handle(phone: string, text: string, session: Session): Promise<void> {
    const faq = await this.faqService.matchByKeywords(
      session.data.clinicId,
      text,
      session.data.language,
    );

    if (faq) {
      await this.whatsappService.sendText(phone, faq.answer);
      session.state = SessionState.IDLE;
      await this.sessionsService.save(session);
    } else {
      const message = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.FAQ_NOT_FOUND,
        {},
        session.data.language,
      );
      await this.whatsappService.sendButtons(phone, message, [
        { id: 'human_agent', title: '👤 Parler à un agent' },
        { id: 'menu', title: '↩️ Menu principal' },
      ]);
    }
  }
}