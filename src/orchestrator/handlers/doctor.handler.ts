import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionsService } from '../../sessions/sessions.service';
import { AvailabilityService } from '../../bot-content/availability.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { MessageKey } from '@prisma/client';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

@Injectable()
export class DoctorHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly availabilityService: AvailabilityService,
    private readonly botMessageService: BotMessageService,
  ) {}

  async handle(phone: string, text: string, session: Session): Promise<void> {
    const doctorId = text.replace('doctor_', '');
    session.data.doctorId = doctorId;
    session.state = SessionState.BOOKING_DATE;
    await this.sessionsService.save(session);

    const availableDates = await this.availabilityService.getAvailableDates(
      doctorId,
      3,
    );

    if (availableDates.length === 0) {
        const message = await this.botMessageService.get(
            session.data.clinicId,
            MessageKey.NO_SLOTS_AVAILABLE,
            {},
            session.data.language,
        );
        await this.whatsappService.sendText(phone, message);
        session.state = SessionState.BOOKING_DOCTOR;
        await this.sessionsService.save(session);
        return;
    }

    const message = await this.botMessageService.get(
      session.data.clinicId,
      MessageKey.SELECT_DATE,
      {},
      session.data.language,
    );

    await this.whatsappService.sendButtons(
      phone,
      message,
      availableDates.map((date) => {
        const d = new Date(date);
        const label = format(d, 'eeee dd MMMM', { locale: session.data.language === 'FR' ? fr : undefined });
        return {
        id: `date_${date}`,
        title: label.charAt(0).toUpperCase() + label.slice(1),
      }}),
    );
  }
}