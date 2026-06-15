import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionsService } from '../../sessions/sessions.service';
import { AvailabilityService } from '../../bot-content/availability.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { MessageKey } from '@prisma/client';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

@Injectable()
export class DateHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly availabilityService: AvailabilityService,
    private readonly botMessageService: BotMessageService,
  ) {}

  async handle(phone: string, text: string, session: Session): Promise<void> {
    const doctorId = session.data.doctorId;
    if (!doctorId) {
      const msg = await this.botMessageService.getSafe(
        session.data.clinicId, MessageKey.ERROR_MISSING_DOCTOR, {}, session.data.language, 'Missing doctor. Please start over.'
      );
      await this.whatsappService.sendText(phone, msg);
      await this.sessionsService.reset(phone);
      return;
    }

    // ── Resolve the selected date ──────────────────────────────────────────
    const date = await this.resolveDate(text, doctorId);

    if (!date) {
      // Input is not a valid date selection — re-show available dates
      await this.showDateList(phone, session, doctorId);
      return;
    }

    // BUG 9: Only set state to BOOKING_TIME AFTER date is validated
    session.data.selectedDate = date;
    session.state = SessionState.BOOKING_TIME;
    await this.sessionsService.save(session);

    const availableSlots = await this.availabilityService.getAvailableSlots(
      doctorId,
      date,
    );

    if (availableSlots.length === 0) {
      const message = await this.botMessageService.getSafe(
        session.data.clinicId, MessageKey.NO_SLOTS_AVAILABLE, {}, session.data.language, 'No slots available.'
      );
      await this.whatsappService.sendText(phone, message);
      session.state = SessionState.BOOKING_DATE;
      await this.sessionsService.save(session);
      await this.showDateList(phone, session, doctorId);
      return;
    }

    const message = await this.botMessageService.getSafe(
      session.data.clinicId, MessageKey.SELECT_TIME, {}, session.data.language, 'Please choose a time:'
    );

    const headerTimes = await this.botMessageService.getSafe(
      session.data.clinicId, MessageKey.HEADER_TIMES, {}, session.data.language, 'Available Times'
    );
    const headerSelectTime = await this.botMessageService.getSafe(
      session.data.clinicId, MessageKey.HEADER_SELECT_TIME, {}, session.data.language, 'Select a time'
    );

    await this.whatsappService.sendInteractiveList(
      phone,
      headerTimes,
      message,
      headerSelectTime,
      [
        {
          title: '',
          rows: availableSlots.map((time) => ({
            id: `time_${time}`,
            title: time,
          })),
        },
      ],
    );
  }

  /**
   * Shows the available date buttons for a given doctor.
   * Reusable for both initial display and re-display on bad input.
   */
  async showDateList(
    phone: string,
    session: Session,
    doctorId: string,
  ): Promise<void> {
    const availableDates = await this.availabilityService.getAvailableDates(
      doctorId,
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

  /**
   * Resolves user input to an ISO date string ("YYYY-MM-DD").
   * Accepts:
   * 1. "date_<YYYY-MM-DD>" prefix (from button selection)
   * 2. Numbered choice ("1", "2", "3") mapped to the available dates
   */
  private async resolveDate(
    text: string,
    doctorId: string,
  ): Promise<string | null> {
    const trimmed = text.trim();

    // Prefixed date from button
    if (trimmed.startsWith('date_')) {
      const candidate = trimmed.replace('date_', '');
      // Validate it's a real ISO date
      if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
        return candidate;
      }
      return null;
    }

    // Numbered choice — fetch dates to map index to value
    const index = parseInt(trimmed, 10);
    if (!isNaN(index) && index >= 1) {
      const availableDates = await this.availabilityService.getAvailableDates(
        doctorId,
        3,
      );
      if (index <= availableDates.length) {
        return availableDates[index - 1];
      }
    }

    return null;
  }
}