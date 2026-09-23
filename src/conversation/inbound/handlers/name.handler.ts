import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '@platform/cache/sessions.service';
import { WhatsAppService } from '@integrations/whatsapp/whatsapp.service';
import { SessionsService } from '@platform/cache/sessions.service';
import { ReasonHandler } from './reason.handler';
import { MessageTemplateService } from '@conversation/content/message-template.service';
import { MessageKey } from '@prisma/client';
import { BookingNavigationHelper } from './booking-navigation.helper';

@Injectable()
export class NameHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly reasonHandler: ReasonHandler,
    private readonly botMessageService: MessageTemplateService,
    private readonly nav: BookingNavigationHelper,
  ) {}

  async handle(phone: string, text: string, session: Session): Promise<void> {
    if (await this.nav.handleMenuCommand(phone, text, session)) return;
    if (await this.nav.handleUnresolvedSelection(phone, text, session)) return;
    const name = text.trim();

    if (!name || name.length < 2) {
      // Name too short — ask again
      const message = await this.botMessageService.getSafe(
        session.data.clinicId, MessageKey.ASK_NAME, {}, session.data.language, 'What is your full name?'
      );
      await this.whatsappService.sendText(phone, message);
      return;
    }

    session.data.patientName = name;
    session.state = SessionState.BOOKING_REASON;
    await this.sessionsService.save(session);

    await this.reasonHandler.showReasonPrompt(phone, session);
  }
}
