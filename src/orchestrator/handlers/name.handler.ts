import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionsService } from '../../sessions/sessions.service';
import { SpecialtyService } from '../../bot-content/specialty.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { MessageKey } from '@prisma/client';

@Injectable()
export class NameHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly specialtyService: SpecialtyService,
    private readonly botMessageService: BotMessageService,
  ) {}

  async handle(phone: string, text: string, session: Session): Promise<void> {
    session.data.patientName = text;
    session.state = SessionState.BOOKING_SPECIALTY;
    await this.sessionsService.save(session);

    const specialties = await this.specialtyService.findActive(
      session.data.clinicId,
      session.data.language,
    );

    const message = await this.botMessageService.get(
      session.data.clinicId,
      MessageKey.SELECT_SPECIALTY,
      {},
      session.data.language,
    );

    await this.whatsappService.sendInteractiveList(
      phone,
      message,
      'Specialties',
      'Select a specialty',
      [
        {
          title: 'Specialties',
          rows: specialties.map((s) => ({
            id: `specialty_${s.slug}`,
            title: s.label,
          })),
        },
      ],
    );
  }
}