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

@Injectable()
export class DoctorHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly availabilityService: AvailabilityService,
    private readonly botMessageService: BotMessageService,
    private readonly doctorService: DoctorService,
  ) {}

  async handle(phone: string, text: string, session: Session): Promise<void> {
    if (!session.data.specialtyId) {
      const msg = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.ERROR_MISSING_SPECIALTY,
        {},
        session.data.language,
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
      // Could not match — re-show the doctor list
      await this.showDoctorList(phone, session, doctors);
      return;
    }

    session.data.doctorId = doctor.id;
    session.state = SessionState.BOOKING_DATE;
    await this.sessionsService.save(session);

    const availableDates = await this.availabilityService.getAvailableDates(
      doctor.id,
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
      await this.showDoctorList(phone, session, doctors);
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
    if (doctors.length === 0) {
      const fallback = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.FALLBACK,
        {},
        session.data.language,
      );
      await this.whatsappService.sendText(phone, fallback);
      return;
    }

    // Re-fetch specialty label for the header
    const message = await this.botMessageService.get(
      session.data.clinicId,
      MessageKey.SELECT_DOCTOR,
      { specialty: '' },
      session.data.language,
    );

    const headerDoctors = await this.botMessageService.get(
      session.data.clinicId,
      MessageKey.HEADER_DOCTORS,
      {},
      session.data.language,
    );

    await this.whatsappService.sendInteractiveList(
      phone,
      message,
      headerDoctors,
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

    // Prefixed ID from interactive list
    if (trimmed.startsWith('doctor_')) {
      const id = trimmed.replace('doctor_', '');
      return doctors.find((d) => d.id === id) ?? null;
    }

    // Numbered choice
    const index = parseInt(trimmed, 10);
    if (!isNaN(index) && index >= 1 && index <= doctors.length) {
      return doctors[index - 1];
    }

    // Name match (case-insensitive)
    const normalised = trimmed.toLowerCase();
    return doctors.find((d) => d.name.toLowerCase() === normalised) ?? null;
  }
}