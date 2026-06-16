import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionsService } from '../../sessions/sessions.service';
import { AvailabilityService } from '../../bot-content/availability.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { MessageKey } from '@prisma/client';
import { DoctorService } from '../../bot-content/doctor.service';
import { Doctor } from '@prisma/client';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { SpecialtyHandler } from './specialty.handler';
import { AiService, Intent } from '../../ai/ai.service';

@Injectable()
export class DoctorHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly availabilityService: AvailabilityService,
    private readonly botMessageService: BotMessageService,
    private readonly doctorService: DoctorService,
    private readonly specialtyHandler: SpecialtyHandler,
    private readonly aiService: AiService,
  ) { }

  async handle(phone: string, text: string, session: Session): Promise<void> {
    const trimmed = text.trim().toLowerCase();

    // Allow returning to main menu from any booking step
    if (trimmed === 'menu') {
      session.state = SessionState.IDLE;
      session.data.languageConfirmed = false;
      await this.sessionsService.save(session);
      await this.specialtyHandler.showWelcomeMenu(phone, session);
      return;
    }

    if (!session.data.specialtyId) {
      const msg = await this.botMessageService.getSafe(
        session.data.clinicId, MessageKey.ERROR_MISSING_SPECIALTY, {}, session.data.language, 'Missing specialty. Please start over.'
      );
      await this.whatsappService.sendText(phone, msg);
      await this.sessionsService.reset(phone);
      return;
    }

    const doctors = await this.doctorService.findBySpecialty(
      session.data.clinicId,
      session.data.specialtyId,
    );

    const doctor = this.resolveDoctor(text, doctors);

    if (!doctor) {
      const intent = await this.aiService.detectIntent(text, session.state, session.data.language);

      if (intent === Intent.CANCEL || intent === Intent.GREETING) {
        session.state = SessionState.IDLE;
        session.data.languageConfirmed = false;
        await this.sessionsService.save(session);
        await this.specialtyHandler.showWelcomeMenu(phone, session);
        return;
      }

      if (intent === Intent.HUMAN_AGENT) {
        session.state = SessionState.AWAITING_HANDOFF;
        await this.sessionsService.save(session);
        const message = await this.botMessageService.getSafe(
          session.data.clinicId, MessageKey.HANDOFF_TRIGGERED, {}, session.data.language, 'Connecting you with our team.'
        );
        await this.whatsappService.sendText(phone, message);
        return;
      }

      await this.showDoctorList(phone, session, doctors);
      return;
    }

    session.data.doctorId = doctor.id;
    session.state = SessionState.BOOKING_DATE;
    await this.sessionsService.save(session);

    const availableDates = await this.availabilityService.getAvailableDates(
      doctor.id,
      3,
      new Date(),
      session.data.timezone,
    );

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
      availableDates.map((date) => {
        const d = new Date(date);
        const label = format(d, 'eeee dd MMMM', {
          locale: session.data.language === 'FR' ? fr : undefined,
        });
        return {
          id: `date_${date}`,
          title: label.charAt(0).toUpperCase() + label.slice(1),
        };
      }),
    );
  }

  private async showDoctorList(
    phone: string,
    session: Session,
    doctors: Doctor[],
  ): Promise<void> {
    // BUG 8: Empty doctors → specific message, escape to specialty list
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

    const message = await this.botMessageService.getSafe(
      session.data.clinicId, MessageKey.SELECT_DOCTOR, { specialty: '' }, session.data.language, 'Here are the available doctors:'
    );

    const headerDoctors = await this.botMessageService.getSafe(
      session.data.clinicId, MessageKey.HEADER_DOCTORS, {}, session.data.language, 'Doctors'
    );

    await this.whatsappService.sendInteractiveList(
      phone,
      headerDoctors,
      message,
      headerDoctors,
      [
        {
          title: headerDoctors,
          rows: doctors.map((d) => ({
            id: `doctor_${d.id}`,
            title: d.name,
          })),
        },
      ],
    );
  }

  /**
   * Tries to match user input to a doctor by:
   * 1. Exact "doctor_<id>" prefix
   * 2. Numbered choice ("1", "2", …)
   * 3. Case-insensitive name match
   */
  private resolveDoctor(text: string, doctors: Doctor[]): Doctor | null {
    const trimmed = text.trim();

    if (trimmed.startsWith('doctor_')) {
      const id = trimmed.replace('doctor_', '');
      return doctors.find((d) => d.id === id) ?? null;
    }

    const index = parseInt(trimmed, 10);
    if (!isNaN(index) && index >= 1 && index <= doctors.length) {
      return doctors[index - 1];
    }

    const normalised = trimmed.toLowerCase();
    return doctors.find((d) => d.name.toLowerCase() === normalised) ?? null;
  }
}