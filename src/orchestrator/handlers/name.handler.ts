import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionsService } from '../../sessions/sessions.service';
import { SpecialtyHandler } from './specialty.handler';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { MessageKey } from '@prisma/client';

@Injectable()
export class NameHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly specialtyHandler: SpecialtyHandler,
    private readonly botMessageService: BotMessageService,
  ) {}

  async handle(phone: string, text: string, session: Session): Promise<void> {
    const name = text.trim();

    if (!name || name.length < 2) {
      // Name too short — ask again
      const message = await this.botMessageService.getSafe(
        session.data.clinicId, MessageKey.ASK_NAME, {}, session.data.language, 'What is your name?'
      );
      await this.whatsappService.sendText(phone, message);
      return;
    }

    session.data.patientName = name;
    session.state = SessionState.BOOKING_SPECIALTY;
    await this.sessionsService.save(session);

    // Show the specialty list — do NOT pass the name text as a selection
    await this.specialtyHandler.showSpecialtyList(phone, session);
  }
}