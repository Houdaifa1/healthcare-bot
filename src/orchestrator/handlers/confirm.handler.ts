import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionsService } from '../../sessions/sessions.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { AppointmentsService } from '../../appointments/appointments.service';
import { DoctorService } from '../../bot-content/doctor.service';
import { MessageKey } from '@prisma/client';
import { AiService, Intent } from '../../ai/ai.service';
import { format, parseISO } from 'date-fns';
import { fr } from 'date-fns/locale';

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
    const trimmed = text.trim().toLowerCase();

    // ── Check button IDs first — no AI needed for explicit button taps ────
    // confirm_yes / confirm_no are the button IDs sent by Meta when user taps
    // the confirm/cancel buttons. Always resolve these without AI to avoid
    // misclassification or infinite reshowConfirmation loops.
    if (trimmed === 'confirm_yes') {
      await this.processConfirmation(phone, session);
      return;
    }

    if (trimmed === 'confirm_no') {
      await this.processCancellation(phone, session);
      return;
    }

    // ── Free-text: use AI intent detection ────────────────────────────────
    const intent = await this.aiService.detectIntent(
      text,
      session.state,
      session.data.language,
    );

    if (intent === Intent.CONFIRM) {
      await this.processConfirmation(phone, session);
    } else if (intent === Intent.CANCEL) {
      await this.processCancellation(phone, session);
    } else {
      await this.reshowConfirmation(phone, session);
    }
  }

  private formatDate(isoDate: string, language: string): string {
    try {
      const d = parseISO(isoDate);
      return format(d, 'eeee dd MMMM yyyy', {
        locale: language === 'FR' ? fr : undefined,
      });
    } catch {
      return isoDate;
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
      const msg = await this.botMessageService.getSafe(
        session.data.clinicId,
        MessageKey.ERROR_MISSING_INFO,
        {},
        session.data.language,
        'Missing information. Please start over.',
      );
      await this.whatsappService.sendText(phone, msg);
      await this.sessionsService.reset(phone);
      return;
    }

    // Strip @lid and @s.whatsapp.net suffixes to store clean phone
    const cleanPhone = phone.replace(/@(lid|s\.whatsapp\.net)$/, '');
    await this.appointmentsService.createAppointment(session.data.clinicId, {
      clinicId: session.data.clinicId,
      doctorId: session.data.doctorId,
      specialtyId: session.data.specialtyId,
      patientName: session.data.patientName,
      patientPhone: cleanPhone,
      appointmentDate: session.data.selectedDate,
      appointmentTime: session.data.selectedTime,
    });

    const doctor = await this.doctorService.findById(session.data.doctorId);
    if (!doctor) {
      const msg = await this.botMessageService.getSafe(
        session.data.clinicId,
        MessageKey.ERROR_DOCTOR_NOT_FOUND,
        {},
        session.data.language,
        'Doctor not found. Please start over.',
      );
      await this.whatsappService.sendText(phone, msg);
      await this.sessionsService.reset(phone);
      return;
    }

    const friendlyDate = this.formatDate(
      session.data.selectedDate,
      session.data.language,
    );

    const message = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.BOOKING_SUCCESS,
      {
        doctorName: doctor.name,
        date: friendlyDate,
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
    const message = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.BOOKING_CANCELLED,
      {},
      session.data.language,
      'Appointment cancelled.',
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

    const friendlyDate = this.formatDate(
      session.data.selectedDate,
      session.data.language,
    );

    const message = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.CONFIRM_BOOKING,
      {
        patientName: session.data.patientName ?? '',
        doctorName: doctor.name,
        date: friendlyDate,
        time: session.data.selectedTime,
        specialty: '',
      },
      session.data.language,
    );

    const btnConfirm = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.BUTTON_CONFIRM,
      {},
      session.data.language,
      'Confirm',
    );
    const btnCancel = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.BUTTON_CANCEL,
      {},
      session.data.language,
      'Cancel',
    );
    await this.whatsappService.sendButtons(phone, message, [
      { id: 'confirm_yes', title: btnConfirm },
      { id: 'confirm_no', title: btnCancel },
    ]);
  }
}
