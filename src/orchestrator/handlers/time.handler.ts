import { Injectable, Logger } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionsService } from '../../sessions/sessions.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { MessageKey } from '@prisma/client';
import { AvailabilityService } from '../../bot-content/availability.service';
import { BookingNavigationHelper } from './booking-navigation.helper';
import { formatFriendlyDate } from './date-format.util';

const META_MAX_SECTIONS = 10;
const META_MAX_ROWS_PER_SECTION = 10;
const META_MAX_DISPLAYABLE_SLOTS = META_MAX_SECTIONS * META_MAX_ROWS_PER_SECTION;
const SECTION_TITLE_MAX = 24;

@Injectable()
export class TimeHandler {
  private readonly logger = new Logger(TimeHandler.name);

  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly botMessageService: BotMessageService,
    private readonly availabilityService: AvailabilityService,
    private readonly nav: BookingNavigationHelper,
  ) { }

  async handle(phone: string, text: string, session: Session): Promise<void> {
    if (await this.nav.handleMenuCommand(phone, text, session)) return;

    const { doctorName, specialtyLabel, selectedDate, clinicId, language } = session.data;

    if (!doctorName || !selectedDate) {
      const msg = await this.botMessageService.getSafe(
        clinicId, MessageKey.ERROR_MISSING_INFO, {}, language, 'Missing information. Please start over.',
      );
      await this.whatsappService.sendText(phone, msg);
      await this.sessionsService.reset(phone);
      return;
    }

    const time = await this.resolveTime(text, doctorName, selectedDate);

    if (!time) {
      if (await this.nav.handleUnresolvedSelection(phone, text, session)) return;
      await this.showTimeList(phone, session, doctorName, selectedDate);
      return;
    }

    session.data.selectedTime = time;
    session.state = SessionState.BOOKING_CONFIRM;
    await this.sessionsService.save(session);

    const friendlyDate = formatFriendlyDate(selectedDate, language);

    const message = await this.botMessageService.getSafe(
      clinicId,
      MessageKey.CONFIRM_BOOKING,
      {
        patientName: session.data.patientName ?? '',
        doctorName: doctorName,
        date: friendlyDate,
        time,
        specialty: specialtyLabel ?? '',
      },
      language,
      `Please confirm your appointment with ${doctorName} on ${friendlyDate} at ${time}.`,
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

  private async showTimeList(
    phone: string,
    session: Session,
    doctorName: string,
    date: string,
  ): Promise<void> {
    const { clinicId, language } = session.data;

    const allSlots = await this.availabilityService.getAvailableSlots(doctorName, date);

    if (allSlots.length === 0) {
      const message = await this.botMessageService.getSafe(
        clinicId, MessageKey.NO_SLOTS_AVAILABLE, {}, language, 'No slots available.',
      );
      await this.whatsappService.sendText(phone, message);
      session.state = SessionState.BOOKING_DATE;
      await this.sessionsService.save(session);
      return;
    }

    const displaySlots = allSlots.slice(0, META_MAX_DISPLAYABLE_SLOTS);

    const [message, header, selectLabel] = await Promise.all([
      this.botMessageService.getSafe(clinicId, MessageKey.SELECT_TIME, {}, language, 'Please choose a time:'),
      this.botMessageService.getSafe(clinicId, MessageKey.HEADER_TIMES, {}, language, 'Available Times'),
      this.botMessageService.getSafe(clinicId, MessageKey.HEADER_SELECT_TIME, {}, language, 'Select a time'),
    ]);

    const totalPages = Math.ceil(displaySlots.length / META_MAX_ROWS_PER_SECTION);
    const sections: Array<{ title: string; rows: Array<{ id: string; title: string }> }> = [];

    for (let i = 0; i < displaySlots.length; i += META_MAX_ROWS_PER_SECTION) {
      const chunk = displaySlots.slice(i, i + META_MAX_ROWS_PER_SECTION);
      if (chunk.length === 0) continue;

      const pageNum = Math.floor(i / META_MAX_ROWS_PER_SECTION) + 1;
      const from = chunk[0];
      const to = chunk[chunk.length - 1];

      const sectionTitle = totalPages > 1
        ? `P${pageNum}/${totalPages}: ${from}-${to}`
        : `${from} - ${to}`;

      sections.push({
        title: sectionTitle.slice(0, SECTION_TITLE_MAX),
        rows: chunk.map((t) => ({ id: `time_${t}`, title: t })),
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

  private async resolveTime(text: string, doctorName: string, date: string): Promise<string | null> {
    const trimmed = text.trim();

    if (trimmed.startsWith('time_')) {
      const candidate = trimmed.slice('time_'.length);
      if (!/^\d{2}:\d{2}$/.test(candidate)) return null;
      const slots = await this.availabilityService.getAvailableSlots(doctorName, date);
      if (!slots.includes(candidate)) return null;
      return candidate;
    }

    if (/^\d{1,2}:\d{2}$/.test(trimmed)) {
      const padded = trimmed.length === 4 ? `0${trimmed}` : trimmed;
      const slots = await this.availabilityService.getAvailableSlots(doctorName, date);
      if (slots.includes(padded)) return padded;
      if (slots.includes(trimmed)) return trimmed;
      return null;
    }

    const index = parseInt(trimmed, 10);
    if (!isNaN(index) && index >= 1) {
      const slots = await this.availabilityService.getAvailableSlots(doctorName, date);
      if (index <= slots.length) return slots[index - 1];
    }

    return null;
  }
}
