import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { MessageKey } from '@prisma/client';
import { SessionsService } from '../../sessions/sessions.service';
import { AiService, Intent } from '../../ai/ai.service';
import { NameHandler } from './name.handler';
import { SpecialtyHandler } from './specialty.handler';
import { FaqHandler } from './faq.handler';

@Injectable()
export class IdleHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly botMessageService: BotMessageService,
    private readonly sessionsService: SessionsService,
    private readonly aiService: AiService,
    private readonly nameHandler: NameHandler,
    private readonly specialtyHandler: SpecialtyHandler,
    private readonly faqHandler: FaqHandler,
  ) {}

  async handle(phone: string, text: string, session: Session): Promise<void> {
    const intent = await this.aiService.detectIntent(
      text,
      session.state,
      session.data.language,
    );

    if (intent === Intent.BOOK_APPOINTMENT) {
      if (session.data.patientName) {
        // Name already known — go straight to specialty
        session.state = SessionState.BOOKING_SPECIALTY;
        await this.sessionsService.save(session);
        await this.specialtyHandler.handle(phone, text, session);
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
      await this.faqHandler.handle(phone, text, session);
      return;
    }

    if (intent === Intent.HUMAN_AGENT) {
      session.state = SessionState.AWAITING_HANDOFF;
      await this.sessionsService.save(session);
      return;
    }

    // Default — show welcome menu
    const message = await this.botMessageService.get(
      session.data.clinicId,
      MessageKey.WELCOME,
      { clinicName: '' },
      session.data.language,
    );

    await this.whatsappService.sendButtons(phone, message, [
      { id: 'book_appointment', title: '📅 Prendre RDV' },
      { id: 'faq', title: '❓ FAQ' },
      { id: 'human_agent', title: '👤 Parler à un agent' },
    ]);
  }
}