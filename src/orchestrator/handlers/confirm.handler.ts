import { Injectable } from '@nestjs/common';
import { Session } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionsService } from '../../sessions/sessions.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { AppointmentsService } from '../../appointments/appointments.service';
import { DoctorService } from '../../bot-content/doctor.service';
import { MessageKey } from '@prisma/client';

@Injectable()
export class ConfirmHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly botMessageService: BotMessageService,
    private readonly appointmentsService: AppointmentsService,
    private readonly doctorService: DoctorService,
  ) {}

  async handle(phone: string, text: string, session: Session): Promise<void> {
    const confirmed = text === 'confirm_yes';

    if (confirmed) {
      if (!session.data.doctorId || !session.data.specialtyId || !session.data.patientName || !session.data.selectedDate || !session.data.selectedTime) {
        await this.whatsappService.sendText(phone, 'Missing booking information. Please start over.');
        await this.sessionsService.reset(phone);
        return;
      }
      await this.appointmentsService.createAppointment({
        clinicId: session.data.clinicId,
        doctorId: session.data.doctorId,
        specialtyId: session.data.specialtyId,
        patientName: session.data.patientName,
        patientPhone: phone,
        appointmentDate: session.data.selectedDate,
        appointmentTime: session.data.selectedTime,
      });

      const doctor = await this.doctorService.findById(session.data.doctorId);
      if (!doctor) {
        await this.whatsappService.sendText(phone, 'Doctor not found. Please start over.');
        await this.sessionsService.reset(phone);
        return;
      }

      const message = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.BOOKING_SUCCESS,
        {
          doctorName: doctor.name,
          date: session.data.selectedDate,
          time: session.data.selectedTime,
        },
        session.data.language,
      );
      await this.whatsappService.sendText(phone, message);
    } else {
      const message = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.BOOKING_CANCELLED,
        {},
        session.data.language,
      );
      await this.whatsappService.sendText(phone, message);
    }

    await this.sessionsService.reset(phone);
  }
}