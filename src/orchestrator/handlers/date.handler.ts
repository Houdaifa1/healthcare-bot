import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionsService } from '../../sessions/sessions.service';
import { AvailabilityService } from '../../bot-content/availability.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { MessageKey } from '@prisma/client';

@Injectable()
export class DateHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly availabilityService: AvailabilityService,
    private readonly botMessageService: BotMessageService,
  ) {}

  async handle(phone: string, text: string, session: Session): Promise<void> {
    const date = text.replace('date_', '');
    session.data.selectedDate = date;
    session.state = SessionState.BOOKING_TIME;
    await this.sessionsService.save(session);

    const doctorId = session.data.doctorId;
    if (!doctorId) {
      await this.whatsappService.sendText(phone, 'Missing doctor information. Please start over.');
      return;
    }

    const availableSlots = await this.availabilityService.getAvailableSlots(
      doctorId,
      date,
    );

    if (availableSlots.length === 0) {
        const message = await this.botMessageService.get(
            session.data.clinicId,
            MessageKey.NO_SLOTS_AVAILABLE,
            {},
            session.data.language,
        );
        await this.whatsappService.sendText(phone, message);
        session.state = SessionState.BOOKING_DATE;
        await this.sessionsService.save(session);
        return;
    }

    const message = await this.botMessageService.get(
      session.data.clinicId,
      MessageKey.SELECT_TIME,
      {},
      session.data.language,
    );

    await this.whatsappService.sendInteractiveList(
      phone,
      message,
      'Times',
      'Select a time',
      [
        {
          title: 'Available Times',
          rows: availableSlots.map((time) => ({
            id: `time_${time}`,
            title: time,
          })),
        },
      ],
    );
  }
}