import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '@platform/cache/sessions.service';
import { WhatsAppService } from '@integrations/whatsapp/whatsapp.service';
import { SessionsService } from '@platform/cache/sessions.service';
import { SpecialtyService } from '@conversation/content/specialty.service';
import { DoctorService } from '@conversation/content/doctor.service';
import { MessageTemplateService } from '@conversation/content/message-template.service';
import { MessageKey } from '@prisma/client';
import { WelcomeMenuService } from '@conversation/content/welcome-menu.service';
import { BookingNavigationHelper } from './booking-navigation.helper';
import { resolveByIdOrIndex } from './resolve-by-id-or-index.util';

@Injectable()
export class SpecialtyHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly specialtyService: SpecialtyService,
    private readonly doctorService: DoctorService,
    private readonly botMessageService: MessageTemplateService,
    private readonly welcomeMenuService: WelcomeMenuService,
    private readonly nav: BookingNavigationHelper,
  ) { }

  async showSpecialtyList(phone: string, session: Session): Promise<void> {
    const specialties = await this.specialtyService.findActive();

    if (specialties.length === 0) {
      const message = await this.botMessageService.getSafe(
        session.data.clinicId,
        MessageKey.NO_SPECIALTIES_AVAILABLE,
        {},
        session.data.language,
        'No specialties are available right now.',
      );
      await this.whatsappService.sendText(phone, message);
      session.state = SessionState.IDLE;
      await this.sessionsService.save(session);
      await this.welcomeMenuService.show(phone, session);
      return;
    }

    const [message, header] = await Promise.all([
      this.botMessageService.getSafe(session.data.clinicId, MessageKey.SELECT_SPECIALTY, {}, session.data.language, 'Please choose your specialty:'),
      this.botMessageService.getSafe(session.data.clinicId, MessageKey.HEADER_SPECIALTIES, {}, session.data.language, 'Specialties'),
    ]);

    await this.whatsappService.sendInteractiveList(
      phone,
      header,
      message,
      header,
      [
        {
          title: '',
          rows: specialties.map((s) => ({
            id: `specialty_${s.specialityId}`,
            title: s.specialityLabel,
          })),
        },
      ],
    );
  }

  async handle(phone: string, text: string, session: Session): Promise<void> {
    if (await this.nav.handleMenuCommand(phone, text, session)) return;

    const specialties = await this.specialtyService.findActive();

    if (specialties.length === 0) {
      const message = await this.botMessageService.getSafe(
        session.data.clinicId,
        MessageKey.NO_SPECIALTIES_AVAILABLE,
        {},
        session.data.language,
        'No specialties are available right now.',
      );
      await this.whatsappService.sendText(phone, message);
      session.state = SessionState.IDLE;
      await this.sessionsService.save(session);
      await this.welcomeMenuService.show(phone, session);
      return;
    }

    const specialty = resolveByIdOrIndex(text, specialties, {
      prefix: 'specialty_',
      idField: 'specialityId',
      labelField: 'specialityLabel',
    });

    if (!specialty) {
      if (await this.nav.handleUnresolvedSelection(phone, text, session)) return;
      await this.showSpecialtyList(phone, session);
      return;
    }

    // Save specialtyId (number) and specialtyLabel in session data
    session.data.specialtyId = specialty.specialityId;
    session.data.specialtyLabel = specialty.specialityLabel;
    session.state = SessionState.BOOKING_DOCTOR;
    await this.sessionsService.save(session);

    const doctors = await this.doctorService.findBySpecialty(
      String(specialty.specialityId),
    );

    if (doctors.length === 0) {
      const message = await this.botMessageService.getSafe(
        session.data.clinicId,
        MessageKey.NO_DOCTORS_FOR_SPECIALTY,
        {},
        session.data.language,
        'No doctors are currently available for this specialty.',
      );
      await this.whatsappService.sendText(phone, message);
      session.state = SessionState.IDLE;
      await this.sessionsService.save(session);
      await this.welcomeMenuService.show(phone, session);
      return;
    }

    const [message, headerDoctors] = await Promise.all([
      this.botMessageService.getSafe(session.data.clinicId, MessageKey.SELECT_DOCTOR, { specialty: specialty.specialityLabel }, session.data.language, 'Here are the available doctors:'),
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
