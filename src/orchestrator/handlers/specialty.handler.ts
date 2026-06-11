import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionsService } from '../../sessions/sessions.service';
import { SpecialtyService } from '../../bot-content/specialty.service';
import { DoctorService } from '../../bot-content/doctor.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { MessageKey } from '@prisma/client';
import { Specialty } from '@prisma/client';

@Injectable()
export class SpecialtyHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly specialtyService: SpecialtyService,
    private readonly doctorService: DoctorService,
    private readonly botMessageService: BotMessageService,
  ) {}

  /**
   * Called by IdleHandler / NameHandler when we want to SHOW the specialty list.
   * Does not try to parse `text` as a selection.
   */
  async showSpecialtyList(phone: string, session: Session): Promise<void> {
    const specialties = await this.specialtyService.findActive(
      session.data.clinicId,
      session.data.language,
    );

    if (specialties.length === 0) {
      const fallback = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.FALLBACK,
        {},
        session.data.language,
      );
      await this.whatsappService.sendText(phone, fallback);
      session.state = SessionState.IDLE;
      await this.sessionsService.save(session);
      return;
    }

    const message = await this.botMessageService.get(
      session.data.clinicId,
      MessageKey.SELECT_SPECIALTY,
      {},
      session.data.language,
    );

    await this.whatsappService.sendInteractiveList(
      phone,
      message,
      'Specialties',
      'Select a specialty',
      [
        {
          title: 'Specialties',
          rows: specialties.map((s) => ({
            id: `specialty_${s.slug}`,
            title: s.label,
          })),
        },
      ],
    );
  }

  /**
   * Called by OrchestratorService when the session state is BOOKING_SPECIALTY
   * and a new message arrives — i.e. the user is responding to the specialty list.
   */
  async handle(phone: string, text: string, session: Session): Promise<void> {
    const specialties = await this.specialtyService.findActive(
      session.data.clinicId,
      session.data.language,
    );

    if (specialties.length === 0) {
      const fallback = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.FALLBACK,
        {},
        session.data.language,
      );
      await this.whatsappService.sendText(phone, fallback);
      session.state = SessionState.IDLE;
      await this.sessionsService.save(session);
      return;
    }

    const specialty = this.resolveSpecialty(text, specialties);

    if (!specialty) {
      // Could not match — re-show the list
      await this.showSpecialtyList(phone, session);
      return;
    }

    session.data.specialtyId = specialty.id;
    session.state = SessionState.BOOKING_DOCTOR;
    await this.sessionsService.save(session);

    const doctors = await this.doctorService.findBySpecialty(
      session.data.clinicId,
      specialty.id,
    );

    if (doctors.length === 0) {
      const fallback = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.FALLBACK,
        {},
        session.data.language,
      );
      await this.whatsappService.sendText(phone, fallback);
      session.state = SessionState.BOOKING_SPECIALTY;
      await this.sessionsService.save(session);
      await this.showSpecialtyList(phone, session);
      return;
    }

    const message = await this.botMessageService.get(
      session.data.clinicId,
      MessageKey.SELECT_DOCTOR,
      { specialty: specialty.label },
      session.data.language,
    );

    await this.whatsappService.sendInteractiveList(
      phone,
      message,
      'Doctors',
      'Select a doctor',
      [
        {
          title: 'Doctors',
          rows: doctors.map((d) => ({
            id: `doctor_${d.id}`,
            title: d.name,
          })),
        },
      ],
    );
  }

  /**
   * Tries to match user input to a specialty by:
   * 1. Exact "specialty_<slug>" prefix
   * 2. Numbered choice ("1", "2", …)
   * 3. Case-insensitive label match
   */
  private resolveSpecialty(
    text: string,
    specialties: Specialty[],
  ): Specialty | null {
    const trimmed = text.trim();

    // Prefixed ID from interactive list
    if (trimmed.startsWith('specialty_')) {
      const slug = trimmed.replace('specialty_', '');
      return specialties.find((s) => s.slug === slug) ?? null;
    }

    // Numbered choice
    const index = parseInt(trimmed, 10);
    if (!isNaN(index) && index >= 1 && index <= specialties.length) {
      return specialties[index - 1];
    }

    // Label match (case-insensitive, accent-tolerant)
    const normalised = trimmed.toLowerCase();
    return (
      specialties.find((s) => s.label.toLowerCase() === normalised) ?? null
    );
  }
}