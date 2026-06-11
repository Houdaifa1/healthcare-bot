import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionsService } from '../../sessions/sessions.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { MessageKey } from '@prisma/client';
import { DoctorService } from '../../bot-content/doctor.service';
import { SpecialtyService } from '../../bot-content/specialty.service';
import { AvailabilityService } from '../../bot-content/availability.service';
import { format, parseISO } from 'date-fns';
import { fr } from 'date-fns/locale';

@Injectable()
export class TimeHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly botMessageService: BotMessageService,
    private readonly doctorService: DoctorService,
    private readonly specialtyService: SpecialtyService,
    private readonly availabilityService: AvailabilityService,
  ) {}

  async handle(phone: string, text: string, session: Session): Promise<void> {
    const doctorId = session.data.doctorId;
    const specialtyId = session.data.specialtyId;
    const selectedDate = session.data.selectedDate;

    if (!doctorId || !specialtyId || !selectedDate) {
      await this.whatsappService.sendText(phone, 'Missing booking information. Please start over.');
      await this.sessionsService.reset(phone);
      return;
    }

    const time = await this.resolveTime(text, doctorId, selectedDate);

    if (!time) {
      await this.showTimeList(phone, session, doctorId, selectedDate);
      return;
    }

    session.data.selectedTime = time;
    session.state = SessionState.BOOKING_CONFIRM;
    await this.sessionsService.save(session);

    const doctor = await this.doctorService.findById(doctorId);
    if (!doctor) {
      await this.whatsappService.sendText(phone, 'Doctor not found. Please start over.');
      await this.sessionsService.reset(phone);
      return;
    }

    const specialties = await this.specialtyService.findActive(session.data.clinicId, session.data.language);
    const matchedSpecialty = specialties.find((s) => s.id === specialtyId);
    if (!matchedSpecialty) {
      await this.whatsappService.sendText(phone, 'Specialty not found. Please start over.');
      await this.sessionsService.reset(phone);
      return;
    }

    const specialty = await this.specialtyService.findBySlug(
      session.data.clinicId,
      matchedSpecialty.slug,
      session.data.language,
    );
    if (!specialty) {
      await this.whatsappService.sendText(phone, 'Specialty not found. Please start over.');
      await this.sessionsService.reset(phone);
      return;
    }

    // FIX: format ISO date as human-readable before passing to template
    const friendlyDate = this.formatDate(selectedDate, session.data.language);

    const message = await this.botMessageService.get(
      session.data.clinicId,
      MessageKey.CONFIRM_BOOKING,
      {
        patientName: session.data.patientName ?? '',
        doctorName: doctor.name,
        date: friendlyDate,
        time,
        specialty: specialty.label,
      },
      session.data.language,
    );

    await this.whatsappService.sendButtons(phone, message, [
      { id: 'confirm_yes', title: '✅ Confirmer' },
      { id: 'confirm_no', title: '❌ Annuler' },
    ]);
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

  private async showTimeList(phone: string, session: Session, doctorId: string, date: string): Promise<void> {
    const availableSlots = await this.availabilityService.getAvailableSlots(doctorId, date);

    if (availableSlots.length === 0) {
      const message = await this.botMessageService.get(
        session.data.clinicId,
        MessageKey.NO_SLOTS_AVAILABLE,
        {},
        session.data.language,
      );
      await this.whatsappService.sendText(phone, message);
      session.state = SessionState.BOOKING_DATE;
      await this.sessionsService.save(session);
      return;
    }

    const message = await this.botMessageService.get(
      session.data.clinicId,
      MessageKey.SELECT_TIME,
      {},
      session.data.language,
    );

    await this.whatsappService.sendInteractiveList(
      phone,
      message,
      session.data.language === 'FR' ? 'Créneaux disponibles' : 'Available Times',
      session.data.language === 'FR' ? 'Choisissez un créneau' : 'Select a time',
      [
        {
          title: session.data.language === 'FR' ? 'Créneaux' : 'Times',
          rows: availableSlots.map((t) => ({ id: `time_${t}`, title: t })),
        },
      ],
    );
  }

  private async resolveTime(text: string, doctorId: string, date: string): Promise<string | null> {
    const trimmed = text.trim();

    if (trimmed.startsWith('time_')) {
      const candidate = trimmed.replace('time_', '');
      if (/^\d{2}:\d{2}$/.test(candidate)) return candidate;
      return null;
    }

    if (/^\d{1,2}:\d{2}$/.test(trimmed)) {
      const padded = trimmed.padStart(5, '0');
      const slots = await this.availabilityService.getAvailableSlots(doctorId, date);
      return slots.includes(padded) ? padded : null;
    }

    const index = parseInt(trimmed, 10);
    if (!isNaN(index) && index >= 1) {
      const slots = await this.availabilityService.getAvailableSlots(doctorId, date);
      if (index <= slots.length) return slots[index - 1];
    }

    return null;
  }
}