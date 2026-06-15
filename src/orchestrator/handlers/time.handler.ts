import { Injectable, Logger } from '@nestjs/common';
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

// Meta interactive list hard limits
const META_MAX_SECTIONS      = 10;
const META_MAX_ROWS_PER_SECTION = 10;
// 10 sections × 10 rows = 100 slots max displayable in one list message
const META_MAX_DISPLAYABLE_SLOTS = META_MAX_SECTIONS * META_MAX_ROWS_PER_SECTION;
// Section title limit is 24 chars — keep generated titles well under this
// Worst case: "P10/10: 09:00-17:30" = 19 chars ✅
const SECTION_TITLE_MAX = 24;

@Injectable()
export class TimeHandler {
  private readonly logger = new Logger(TimeHandler.name);

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

    const { doctorId, specialtyId, selectedDate, clinicId, language } = session.data;

    if (!doctorId || !specialtyId || !selectedDate) {
      const msg = await this.botMessageService.getSafe(
        clinicId, MessageKey.ERROR_MISSING_INFO, {}, language, 'Missing information. Please start over.',
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
        clinicId, MessageKey.ERROR_DOCTOR_NOT_FOUND, {}, language, 'Doctor not found. Please start over.',
      );
      await this.whatsappService.sendText(phone, msg);
      await this.sessionsService.reset(phone);
      return;
    }

    const matchedSpecialty = await this.specialtyService.findById(specialtyId, language);
    if (!matchedSpecialty) {
      const msg = await this.botMessageService.getSafe(
        clinicId, MessageKey.ERROR_SPECIALTY_NOT_FOUND, {}, language, 'Specialty not found. Please start over.',
      );
      await this.whatsappService.sendText(phone, msg);
      await this.sessionsService.reset(phone);
      return;
    }

    const friendlyDate = this.formatDate(selectedDate, language);
    const specialtyLabels = matchedSpecialty.labels as Record<string, string>;

    const message = await this.botMessageService.getSafe(
      clinicId,
      MessageKey.CONFIRM_BOOKING,
      {
        patientName: session.data.patientName ?? '',
        doctorName:  doctor.name,
        date:        friendlyDate,
        time,
        specialty:   specialtyLabels?.[language] ?? specialtyLabels?.['FR'] ?? matchedSpecialty.slug,
      },
      language,
    );

    const [btnConfirm, btnCancel] = await Promise.all([
      this.botMessageService.getSafe(clinicId, MessageKey.BUTTON_CONFIRM, {}, language, 'Confirm'),
      this.botMessageService.getSafe(clinicId, MessageKey.BUTTON_CANCEL,  {}, language, 'Cancel'),
    ]);

    await this.whatsappService.sendButtons(phone, message, [
      { id: 'confirm_yes', title: btnConfirm },
      { id: 'confirm_no',  title: btnCancel  },
    ]);
  }

  // ─── Time list display ────────────────────────────────────────────────────

  private async showTimeList(
    phone:    string,
    session:  Session,
    doctorId: string,
    date:     string,
  ): Promise<void> {
    const { clinicId, language } = session.data;

    const allSlots = await this.availabilityService.getAvailableSlots(doctorId, date);

    this.logger.log(
      `[TimeHandler] slots for doctor=${doctorId} date=${date}: ${allSlots.length}` +
      (allSlots.length > 0 ? ` [${allSlots[0]} – ${allSlots[allSlots.length - 1]}]` : ''),
    );

    if (allSlots.length === 0) {
      const message = await this.botMessageService.getSafe(
        clinicId, MessageKey.NO_SLOTS_AVAILABLE, {}, language, 'No slots available.',
      );
      await this.whatsappService.sendText(phone, message);
      session.state = SessionState.BOOKING_DATE;
      await this.sessionsService.save(session);
      return;
    }

    if (allSlots.length > META_MAX_DISPLAYABLE_SLOTS) {
      this.logger.warn(
        `[TimeHandler] ${allSlots.length} slots exceeds Meta cap (${META_MAX_DISPLAYABLE_SLOTS}). ` +
        `Only first ${META_MAX_DISPLAYABLE_SLOTS} will be shown for doctor=${doctorId} date=${date}.`,
      );
    }

    const displaySlots = allSlots.slice(0, META_MAX_DISPLAYABLE_SLOTS);

    const [message, header, selectLabel] = await Promise.all([
      this.botMessageService.getSafe(clinicId, MessageKey.SELECT_TIME,        {}, language, 'Please choose a time:'),
      this.botMessageService.getSafe(clinicId, MessageKey.HEADER_TIMES,       {}, language, 'Available Times'),
      this.botMessageService.getSafe(clinicId, MessageKey.HEADER_SELECT_TIME, {}, language, 'Select a time'),
    ]);

    const totalPages = Math.ceil(displaySlots.length / META_MAX_ROWS_PER_SECTION);
    const sections: Array<{ title: string; rows: Array<{ id: string; title: string }> }> = [];

    for (let i = 0; i < displaySlots.length; i += META_MAX_ROWS_PER_SECTION) {
      const chunk = displaySlots.slice(i, i + META_MAX_ROWS_PER_SECTION);
      if (chunk.length === 0) continue;

      const pageNum = Math.floor(i / META_MAX_ROWS_PER_SECTION) + 1;
      const from    = chunk[0];
      const to      = chunk[chunk.length - 1];

      // ── FIX: compact title format stays well under Meta's 24-char section title limit.
      // The previous format "Page N/N — HH:mm – HH:mm" hit exactly 24 chars for
      // page 1 of 2, causing sendInteractiveList to silently truncate the title mid-time
      // ("Page 1/2 — 09:00 – 13:") which corrupted the section. Meta dropped it, making
      // the list appear to end at 13:30 even when slots through 17:30 existed.
      // Worst case now: "P10/10: 09:00-17:30" = 19 chars — safely under the limit.
      const sectionTitle = totalPages > 1
        ? `P${pageNum}/${totalPages}: ${from}-${to}`  // e.g. "P1/2: 09:00-13:30" (18 chars)
        : `${from} - ${to}`;                           // e.g. "09:00 - 17:30"     (13 chars)

      // Defensive assertion — catch this at runtime if slot times ever change format
      if (sectionTitle.length > SECTION_TITLE_MAX) {
        this.logger.error(
          `[TimeHandler] Section title "${sectionTitle}" (${sectionTitle.length} chars) exceeds ` +
          `Meta's ${SECTION_TITLE_MAX}-char limit. Slots may be hidden from patients.`,
        );
      }

      sections.push({
        title: sectionTitle,
        rows:  chunk.map((t) => ({ id: `time_${t}`, title: t })),
      });
    }

    await this.whatsappService.sendInteractiveList(
      phone,
      header,
      message,
      selectLabel,
      sections,
    );
  }

  // ─── Time resolution ──────────────────────────────────────────────────────

  /**
   * Resolves user input to a confirmed available slot string ("HH:mm").
   *
   * Accepts:
   *   1. "time_HH:mm"  — list-reply id from showTimeList (primary path)
   *   2. "HH:mm" / "H:mm" — manually typed time
   *   3. "N" (integer) — 1-based index into the slot list
   *
   * Returns null if the input doesn't match any available slot → caller re-shows the list.
   */
  private async resolveTime(text: string, doctorId: string, date: string): Promise<string | null> {
    const trimmed = text.trim();

    // ── Path 1: list-reply id (e.g. "time_09:30") ────────────────────────
    if (trimmed.startsWith('time_')) {
      const candidate = trimmed.slice('time_'.length);
      if (!/^\d{2}:\d{2}$/.test(candidate)) return null;

      // Verify against live slots — reject stale ids if slot was just booked
      const slots = await this.availabilityService.getAvailableSlots(doctorId, date);
      if (!slots.includes(candidate)) {
        this.logger.warn(
          `[TimeHandler] Stale list-reply "time_${candidate}" not in current slots ` +
          `for doctor=${doctorId} date=${date}`,
        );
        return null;
      }
      return candidate;
    }

    // ── Path 2: manually typed time ───────────────────────────────────────
    if (/^\d{1,2}:\d{2}$/.test(trimmed)) {
      const padded = trimmed.length === 4 ? `0${trimmed}` : trimmed;
      const slots = await this.availabilityService.getAvailableSlots(doctorId, date);
      if (slots.includes(padded)) return padded;
      // Defensive: also check unpadded form in case DB returns non-zero-padded strings
      if (slots.includes(trimmed)) return trimmed;
      return null;
    }

    // ── Path 3: 1-based numeric index ─────────────────────────────────────
    const index = parseInt(trimmed, 10);
    if (!isNaN(index) && index >= 1) {
      const slots = await this.availabilityService.getAvailableSlots(doctorId, date);
      if (index <= slots.length) return slots[index - 1];
    }

    return null;
  }

  // ─── Formatting ───────────────────────────────────────────────────────────

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
}