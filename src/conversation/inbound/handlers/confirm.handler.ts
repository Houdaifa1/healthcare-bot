import { Injectable } from '@nestjs/common';
import { Session } from '@platform/cache/sessions.service';
import { WhatsAppService } from '@integrations/whatsapp/whatsapp.service';
import { SessionsService } from '@platform/cache/sessions.service';
import { MessageTemplateService } from '@conversation/content/message-template.service';
import { ClinOpsService } from '@integrations/clinops/clinops.service';
import { PrismaService } from '@platform/database/prisma.service';
import { MessageKey, BookingSource, BookingRequestStatus, AppointmentStatus } from '@prisma/client';
import { IntentClassifierService, Intent } from '@conversation/nlu/intent-classifier.service';
import { formatFriendlyDate } from './date-format.util';
import { normalizePatientPhone } from '@platform/shared/phone.util';
import type { ClinOpsPatient } from '@integrations/clinops/clinops.types';

@Injectable()
export class ConfirmHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly botMessageService: MessageTemplateService,
    private readonly clinOpsService: ClinOpsService,
    private readonly prisma: PrismaService,
    private readonly aiService: IntentClassifierService,
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
    const { doctorName, patientName, selectedDate, selectedTime, specialtyLabel, specialtyId,
      reason, clinicId, language } = session.data;

    if (!doctorName || !patientName || !selectedDate || !selectedTime || !specialtyLabel ||
        !specialtyId || !reason?.trim()) {
      const msg = await this.botMessageService.getSafe(
        clinicId, MessageKey.ERROR_MISSING_INFO, {}, language, 'Missing information. Please start over.'
      );
      await this.whatsappService.sendText(phone, msg);
      await this.sessionsService.reset(phone);
      return;
    }

    const cleanPhone = phone.replace(/@(lid|s\.whatsapp\.net)$/, '');

    // Phone search is only a hint. Multiple patients may share a number, and
    // a search result is not proof of identity. Leave an ambiguous ID blank.
    const searchResult = await this.clinOpsService.searchPatients({
      numeroTelephone: `+${cleanPhone}`,
    }).catch((): ClinOpsPatient[] => []);

    const patientIds = new Set(searchResult.filter(patient =>
      [patient.numeroTelephonePrincipale, patient.numeroTelephoneSecondaire].some(number =>
        number && normalizePatientPhone(number) === normalizePatientPhone(cleanPhone)))
      .map(patient => patient.patient_id));
    const clinopsPatientId = patientIds.size === 1 ? [...patientIds][0] : null;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const previous = await this.prisma.bookingRequest.findFirst({
      where: {
        clinicId,
        status: BookingRequestStatus.CONFIRMED,
        appointmentId: { not: null },
        appointment: { is: { status: AppointmentStatus.CONFIRMED,
          appointmentDate: { gte: today } } },
        OR: [
          { source: BookingSource.INBOUND, patientPhone: cleanPhone, patientName },
          { source: BookingSource.CAMPAIGN, campaignPatient: { is: {
            phone: cleanPhone, patientName,
          } } },
          ...(clinopsPatientId ? [
            { clinopsPatientId },
            { campaignPatient: { is: { clinopsPatientId } } },
          ] : []),
        ],
      },
      orderBy: { confirmedAt: 'desc' },
    });

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
        previousBookingRequestId: previous?.id ?? null,
        patientName,
        patientPhone: cleanPhone,
        language,
        clinopsPatientId,
        clinopsSpecialityId: Number(specialtyId),
        preferredDoctor: doctorName,
        preferredSpecialty: specialtyLabel,
        preferredDateRange,
        preferredTimeRange: selectedTime,
        requestedDate: selectedDate,
        requestedTime: selectedTime,
        reason: reason.trim(),
        rawPatientRequest: `WhatsApp booking request: ${reason.trim()}; ${doctorName} (${specialtyLabel}) on ${selectedDate} at ${selectedTime}`,
      },
    });

    // Persist the completed state before the acknowledgement. A failed send
    // must not cause a queue retry to create the booking request again.
    await this.sessionsService.reset(phone);

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
  }

  private async processCancellation(phone: string, session: Session): Promise<void> {
    const message = await this.botMessageService.getSafe(
      session.data.clinicId, MessageKey.BOOKING_CANCELLED, {}, session.data.language,
      'This booking request was stopped. Any existing appointment remains unchanged.'
    );
    await this.whatsappService.sendText(phone, message);
    await this.sessionsService.reset(phone);
  }

  private async reshowConfirmation(phone: string, session: Session): Promise<void> {
    const { doctorName, selectedDate, selectedTime, clinicId, language, patientName, specialtyLabel, reason } = session.data;

    if (!doctorName || !selectedDate || !selectedTime || !reason) {
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
      `Please confirm your appointment request with ${doctorName} on ${friendlyDate} at ${selectedTime}.`,
    );

    const [btnConfirm, btnCancel] = await Promise.all([
      this.botMessageService.getSafe(clinicId, MessageKey.BUTTON_CONFIRM, {}, language, 'Confirm'),
      this.botMessageService.getSafe(clinicId, MessageKey.BUTTON_CANCEL, {}, language, 'Cancel'),
    ]);
    const reasonLabel = language === 'EN' ? 'Reason' : 'Motif';
    await this.whatsappService.sendButtons(phone, `${reasonLabel}: ${reason}\n\n${message}`, [
      { id: 'confirm_yes', title: btnConfirm },
      { id: 'confirm_no', title: btnCancel },
    ]);
  }
}
