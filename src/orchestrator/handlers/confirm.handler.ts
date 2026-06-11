import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionsService } from '../../sessions/sessions.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { AppointmentsService } from '../../appointments/appointments.service';
import { DoctorService } from '../../bot-content/doctor.service';
import { MessageKey } from '@prisma/client';
import { AiService, Intent } from '../../ai/ai.service';

@Injectable()
export class ConfirmHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly botMessageService: BotMessageService,
    private readonly appointmentsService: AppointmentsService,
    private readonly doctorService: DoctorService,
    private readonly aiService: AiService,
  ) {}

  async handle(phone: string, text: string, session: Session): Promise<void> {
    const intent = await this.aiService.detectIntent(
      text,
      session.state,
      session.data.language,
    );

    // Anything that isn't an explicit CONFIRM is treated as a cancellation,
    // which is the safer default (never book without clear confirmation).
    if (intent === Intent.CONFIRM) {
      await this.processConfirmation(phone, session);
    } else if (intent === Intent.CANCEL) {
      await this.processCancellation(phone, session);
    } else {
      // Ambiguous input — re-show the confirmation prompt
      await this.reshowConfirmation(phone, session);
    }
  }

  private async processConfirmation(
    phone: string,
    session: Session,
  ): Promise<void> {
    if (
      !session.data.doctorId ||
      !session.data.specialtyId ||
      !session.data.patientName ||
      !session.data.selectedDate ||
      !session.data.selectedTime
    ) {
      await this.whatsappService.sendText(
        phone,
        'Missing booking information. Please start over.',
      );
      await this.sessionsService.reset(phone);
      return;
    }

    await this.appointmentsService.createAppointment(session.data.clinicId, {
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
      await this.whatsappService.sendText(
        phone,
        'Doctor not found. Please start over.',
      );
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
    await this.sessionsService.reset(phone);
  }

  private async processCancellation(
    phone: string,
    session: Session,
  ): Promise<void> {
    const message = await this.botMessageService.get(
      session.data.clinicId,
      MessageKey.BOOKING_CANCELLED,
      {},
      session.data.language,
    );
    await this.whatsappService.sendText(phone, message);
    await this.sessionsService.reset(phone);
  }

  private async reshowConfirmation(
    phone: string,
    session: Session,
  ): Promise<void> {
    if (
      !session.data.doctorId ||
      !session.data.selectedDate ||
      !session.data.selectedTime
    ) {
      await this.sessionsService.reset(phone);
      return;
    }

    const doctor = await this.doctorService.findById(session.data.doctorId);
    if (!doctor) {
      await this.sessionsService.reset(phone);
      return;
    }

    const message = await this.botMessageService.get(
      session.data.clinicId,
      MessageKey.CONFIRM_BOOKING,
      {
        patientName: session.data.patientName ?? '',
        doctorName: doctor.name,
        date: session.data.selectedDate,
        time: session.data.selectedTime,
        specialty: '',
      },
      session.data.language,
    );

    await this.whatsappService.sendButtons(phone, message, [
      { id: 'confirm_yes', title: '✅ Confirmer' },
      { id: 'confirm_no', title: '❌ Annuler' },
    ]);
  }
}