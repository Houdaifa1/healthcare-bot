import { Injectable } from '@nestjs/common';
import { Session } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionsService } from '../../sessions/sessions.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { ClinOpsService } from '../../clinops/clinops.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MessageKey, BookingSource } from '@prisma/client';
import { AiService, Intent } from '../../ai/ai.service';
import { formatFriendlyDate } from './date-format.util';

@Injectable()
export class ConfirmHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly botMessageService: BotMessageService,
    private readonly clinOpsService: ClinOpsService,
    private readonly prisma: PrismaService,
    private readonly aiService: AiService,
  ) {}

  async handle(phone: string, text: string, session: Session): Promise<void> {
    const trimmed = text.trim().toLowerCase();

    if (trimmed === 'confirm_yes') {
      await this.processConfirmation(phone, session);
      return;
    }

    if (trimmed === 'confirm_no') {
      await this.processCancellation(phone, session);
      return;
    }

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

  private async processConfirmation(phone: string, session: Session): Promise<void> {
    const { doctorName, patientName, selectedDate, selectedTime, specialtyLabel, clinicId, language } = session.data;

    if (!doctorName || !patientName || !selectedDate || !selectedTime) {
      const msg = await this.botMessageService.getSafe(
        clinicId, MessageKey.ERROR_MISSING_INFO, {}, language, 'Missing information. Please start over.'
      );
      await this.whatsappService.sendText(phone, msg);
      await this.sessionsService.reset(phone);
      return;
    }

    const cleanPhone = phone.replace(/@(lid|s\.whatsapp\.net)$/, '');

    // Best-effort lookup so a returning patient's ClinOps identity travels with
    // the review-queue entry; not required for the booking request to exist.
    const searchResult = await this.clinOpsService.searchPatients({
      numeroTelephone: `+${cleanPhone}`,
    }).catch(() => []);

    const clinopsPatientId = searchResult?.[0]?.patient_id;

    // Human-readable "preferred date" for the admin dashboard — inbound
    // requests already have an exact slot, unlike campaign's free-text
    // preferredDateRange, but the dashboard column reads this same field.
    const preferredDateRange = `${selectedDate} ${selectedTime}`;

    // Land in the same source-agnostic review queue outbound/campaign bookings
    // use — staff confirm/reject from the admin dashboard, same table, same UI.
    await this.prisma.bookingRequest.create({
      data: {
        clinicId,
        source: BookingSource.INBOUND,
        patientName,
        patientPhone: cleanPhone,
        language,
        clinopsPatientId,
        preferredDoctor: doctorName,
        preferredSpecialty: specialtyLabel,
        preferredDateRange,
        requestedDate: selectedDate,
        requestedTime: selectedTime,
        reason: specialtyLabel,
        rawPatientRequest: `WhatsApp booking request: ${doctorName}${specialtyLabel ? ` (${specialtyLabel})` : ''} on ${selectedDate} at ${selectedTime}`,
      },
    });

    const friendlyDate = formatFriendlyDate(selectedDate, language);

    const message = await this.botMessageService.getSafe(
      clinicId,
      MessageKey.BOOKING_REQUEST_RECEIVED,
      {
        doctorName: doctorName,
        date: friendlyDate,
        time: selectedTime,
      },
      language,
      `Your appointment request with ${doctorName} on ${friendlyDate} at ${selectedTime} has been received. Our team will confirm it shortly.`,
    );
    await this.whatsappService.sendText(phone, message);
    await this.sessionsService.reset(phone);
  }

  private async processCancellation(phone: string, session: Session): Promise<void> {
    const message = await this.botMessageService.getSafe(
      session.data.clinicId, MessageKey.BOOKING_CANCELLED, {}, session.data.language, 'Appointment cancelled.'
    );
    await this.whatsappService.sendText(phone, message);
    await this.sessionsService.reset(phone);
  }

  private async reshowConfirmation(phone: string, session: Session): Promise<void> {
    const { doctorName, selectedDate, selectedTime, clinicId, language, patientName, specialtyLabel } = session.data;

    if (!doctorName || !selectedDate || !selectedTime) {
      await this.sessionsService.reset(phone);
      return;
    }

    const friendlyDate = formatFriendlyDate(selectedDate, language);

    const message = await this.botMessageService.getSafe(
      clinicId,
      MessageKey.CONFIRM_BOOKING,
      {
        patientName: patientName ?? '',
        doctorName: doctorName,
        date: friendlyDate,
        time: selectedTime,
        specialty: specialtyLabel ?? '',
      },
      language,
      `Please confirm your appointment with ${doctorName} on ${friendlyDate} at ${selectedTime}.`,
    );

    const [btnConfirm, btnCancel] = await Promise.all([
      this.botMessageService.getSafe(clinicId, MessageKey.BUTTON_CONFIRM, {}, language, 'Confirm'),
      this.botMessageService.getSafe(clinicId, MessageKey.BUTTON_CANCEL, {}, language, 'Cancel'),
    ]);
    await this.whatsappService.sendButtons(phone, message, [
      { id: 'confirm_yes', title: btnConfirm },
      { id: 'confirm_no', title: btnCancel },
    ]);
  }
}