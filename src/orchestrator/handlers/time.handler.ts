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
    const trimmed = text.trim().toLowerCase();

    if (trimmed === 'menu') {
      session.state = SessionState.IDLE;
      await this.sessionsService.save(session);
      return;
    }

    const doctorId = session.data.doctorId;
    const specialtyId = session.data.specialtyId;
    const selectedDate = session.data.selectedDate;

    if (!doctorId || !specialtyId || !selectedDate) {
      const msg = await this.botMessageService.getSafe(
        session.data.clinicId, MessageKey.ERROR_MISSING_INFO, {}, session.data.language, 'Missing information. Please start over.'
      );
      await this.whatsappService.sendText(phone, msg);
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
      const msg = await this.botMessageService.getSafe(
        session.data.clinicId, MessageKey.ERROR_DOCTOR_NOT_FOUND, {}, session.data.language, 'Doctor not found. Please start over.'
      );
      await this.whatsappService.sendText(phone, msg);
      await this.sessionsService.reset(phone);
      return;
    }

    const matchedSpecialty = await this.specialtyService.findById(specialtyId, session.data.language);
    if (!matchedSpecialty) {
      const msg = await this.botMessageService.getSafe(
        session.data.clinicId, MessageKey.ERROR_SPECIALTY_NOT_FOUND, {}, session.data.language, 'Specialty not found. Please start over.'
      );
      await this.whatsappService.sendText(phone, msg);
      await this.sessionsService.reset(phone);
      return;
    }

    const friendlyDate = this.formatDate(selectedDate, session.data.language);

    const message = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.CONFIRM_BOOKING,
      {
        patientName: session.data.patientName ?? '',
        doctorName: doctor.name,
        date: friendlyDate,
        time,
        specialty: (matchedSpecialty.labels as Record<string, string>)?.[session.data.language] ?? (matchedSpecialty.labels as Record<string, string>)?.['FR'] ?? matchedSpecialty.slug,
      },
      session.data.language,
    );

    const btnConfirm = await this.botMessageService.getSafe(
      session.data.clinicId, MessageKey.BUTTON_CONFIRM, {}, session.data.language, 'Confirm'
    );
    const btnCancel = await this.botMessageService.getSafe(
      session.data.clinicId, MessageKey.BUTTON_CANCEL, {}, session.data.language, 'Cancel'
    );
    await this.whatsappService.sendButtons(phone, message, [
      { id: 'confirm_yes', title: btnConfirm },
      { id: 'confirm_no', title: btnCancel },
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
      const message = await this.botMessageService.getSafe(
        session.data.clinicId, MessageKey.NO_SLOTS_AVAILABLE, {}, session.data.language, 'No slots available.'
      );
      await this.whatsappService.sendText(phone, message);
      session.state = SessionState.BOOKING_DATE;
      await this.sessionsService.save(session);
      return;
    }

    const message = await this.botMessageService.getSafe(
      session.data.clinicId, MessageKey.SELECT_TIME, {}, session.data.language, 'Please choose a time:'
    );

    const header = await this.botMessageService.getSafe(
      session.data.clinicId, MessageKey.HEADER_TIMES, {}, session.data.language, 'Available Times'
    );

    const selectLabel = await this.botMessageService.getSafe(
      session.data.clinicId, MessageKey.HEADER_SELECT_TIME, {}, session.data.language, 'Select a time'
    );

    const pageLabel = await this.botMessageService.getSafe(
      session.data.clinicId, 
      MessageKey.HEADER_TIME_PAGE, 
      {}, 
      session.data.language, 
      'Page' 
    );

    const CHUNK_SIZE = 10;
    const sections: Array<{ title: string; rows: Array<{ id: string; title: string }> }> = [];

    const totalPages = Math.ceil(availableSlots.length / CHUNK_SIZE);

    for (let i = 0; i < availableSlots.length; i += CHUNK_SIZE) {
      const chunk = availableSlots.slice(i, i + CHUNK_SIZE);
      if (chunk.length === 0) continue;

      const pageNum = Math.floor(i / CHUNK_SIZE) + 1;
      const from = chunk[0];
      const to = chunk[chunk.length - 1];

      const sectionTitle = totalPages > 1 
        ? `${pageLabel} ${pageNum}/${totalPages} — ${from} – ${to}`
        : `${from} – ${to}`;

      sections.push({
        title: sectionTitle,
        rows: chunk.map((t) => ({ 
          id: `time_${t}`, 
          title: t 
        })),
      });
    }

    const safeSections = sections.slice(0, 10);

    await this.whatsappService.sendInteractiveList(
      phone,
      header,
      message,
      selectLabel,
      safeSections,
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