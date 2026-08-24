import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '@platform/cache/sessions.service';
import { WhatsAppService } from '@integrations/whatsapp/whatsapp.service';
import { SessionsService } from '@platform/cache/sessions.service';
import { AvailabilityService } from '@conversation/content/availability.service';
import { MessageTemplateService } from '@conversation/content/message-template.service';
import { MessageKey } from '@prisma/client';
import { DoctorService } from '@conversation/content/doctor.service';
import { ClinOpsDoctor } from '@integrations/clinops/clinops.types';
import { SpecialtyHandler } from './specialty.handler';
import { BookingNavigationHelper } from './booking-navigation.helper';
import { resolveByIdOrIndex } from './resolve-by-id-or-index.util';
import { formatDateButtonLabel } from './date-format.util';

@Injectable()
export class DoctorHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly availabilityService: AvailabilityService,
    private readonly botMessageService: MessageTemplateService,
    private readonly doctorService: DoctorService,
    private readonly specialtyHandler: SpecialtyHandler,
    private readonly nav: BookingNavigationHelper,
  ) { }

  async handle(phone: string, text: string, session: Session): Promise<void> {
    if (await this.nav.handleMenuCommand(phone, text, session)) return;

    if (!session.data.specialtyId) {
      const msg = await this.botMessageService.getSafe(
        session.data.clinicId, MessageKey.ERROR_MISSING_SPECIALTY, {}, session.data.language, 'Missing specialty. Please start over.'
      );
      await this.whatsappService.sendText(phone, msg);
      await this.sessionsService.reset(phone);
      return;
    }

    const doctors = await this.doctorService.findBySpecialty(
      String(session.data.specialtyId),
    );

    const doctor = resolveByIdOrIndex(text, doctors, {
      prefix: 'doctor_',
      idField: 'doctorId',
      labelField: 'doctorLabel',
    });

    if (!doctor) {
      if (await this.nav.handleUnresolvedSelection(phone, text, session)) return;
      await this.showDoctorList(phone, session, doctors);
      return;
    }

    // Save exact doctorName (doctorLabel) and doctorId in session
    session.data.doctorId = doctor.doctorId;
    session.data.doctorName = doctor.doctorLabel;
    session.state = SessionState.BOOKING_DATE;
    await this.sessionsService.save(session);

    const availableDates = await this.availabilityService.getAvailableDates(doctor.doctorLabel, 3);

    if (availableDates.length === 0) {
      const message = await this.botMessageService.getSafe(
        session.data.clinicId, MessageKey.NO_SLOTS_AVAILABLE, {}, session.data.language, 'No slots available.'
      );
      await this.whatsappService.sendText(phone, message);
      session.state = SessionState.BOOKING_DOCTOR;
      await this.sessionsService.save(session);
      await this.showDoctorList(phone, session, doctors);
      return;
    }

    const message = await this.botMessageService.getSafe(
      session.data.clinicId, MessageKey.SELECT_DATE, {}, session.data.language, 'Please choose a date:'
    );

    await this.whatsappService.sendButtons(
      phone,
      message,
      availableDates.map((item) => ({
        id: `date_${item.date}`,
        title: formatDateButtonLabel(item.date, session.data.language),
      })),
    );
  }

  async showDoctorList(
    phone: string,
    session: Session,
    doctors: ClinOpsDoctor[],
  ): Promise<void> {
    if (doctors.length === 0) {
      const message = await this.botMessageService.getSafe(
        session.data.clinicId,
        MessageKey.NO_DOCTORS_FOR_SPECIALTY,
        {},
        session.data.language,
        'No doctors are currently available for this specialty.',
      );
      await this.whatsappService.sendText(phone, message);
      session.state = SessionState.BOOKING_SPECIALTY;
      await this.sessionsService.save(session);
      await this.specialtyHandler.showSpecialtyList(phone, session);
      return;
    }

    const [message, headerDoctors] = await Promise.all([
      this.botMessageService.getSafe(session.data.clinicId, MessageKey.SELECT_DOCTOR, { specialty: '' }, session.data.language, 'Here are the available doctors:'),
      this.botMessageService.getSafe(session.data.clinicId, MessageKey.HEADER_DOCTORS, {}, session.data.language, 'Doctors'),
    ]);

    await this.whatsappService.sendInteractiveList(
      phone,
      headerDoctors,
      message,
      headerDoctors,
      [
        {
          title: headerDoctors,
          rows: doctors.map((d) => ({
            id: `doctor_${d.doctorId}`,
            title: d.doctorLabel,
          })),
        },
      ],
    );
  }
}
