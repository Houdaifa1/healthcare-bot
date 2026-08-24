import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '@platform/cache/sessions.service';
import { WhatsAppService } from '@integrations/whatsapp/whatsapp.service';
import { SessionsService } from '@platform/cache/sessions.service';
import { AvailabilityService } from '@conversation/content/availability.service';
import { MessageTemplateService } from '@conversation/content/message-template.service';
import { MessageKey } from '@prisma/client';
import { BookingNavigationHelper } from './booking-navigation.helper';
import { formatDateButtonLabel } from './date-format.util';

@Injectable()
export class DateHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly availabilityService: AvailabilityService,
    private readonly botMessageService: MessageTemplateService,
    private readonly nav: BookingNavigationHelper,
  ) { }

  async handle(phone: string, text: string, session: Session): Promise<void> {
    if (await this.nav.handleMenuCommand(phone, text, session)) return;

    const doctorName = session.data.doctorName;
    if (!doctorName) {
      const msg = await this.botMessageService.getSafe(
        session.data.clinicId, MessageKey.ERROR_MISSING_DOCTOR, {}, session.data.language, 'Missing doctor. Please start over.'
      );
      await this.whatsappService.sendText(phone, msg);
      await this.sessionsService.reset(phone);
      return;
    }

    const date = await this.resolveDate(text, doctorName);

    if (!date) {
      if (await this.nav.handleUnresolvedSelection(phone, text, session)) return;
      await this.showDateList(phone, session);
      return;
    }

    session.data.selectedDate = date;
    session.state = SessionState.BOOKING_TIME;
    await this.sessionsService.save(session);

    const availableSlots = await this.availabilityService.getAvailableSlots(
      doctorName,
      date,
    );

    if (availableSlots.length === 0) {
      const message = await this.botMessageService.getSafe(
        session.data.clinicId, MessageKey.NO_SLOTS_AVAILABLE, {}, session.data.language, 'No slots available.'
      );
      await this.whatsappService.sendText(phone, message);
      session.state = SessionState.BOOKING_DATE;
      await this.sessionsService.save(session);
      await this.showDateList(phone, session);
      return;
    }

    const [message, headerTimes, headerSelectTime] = await Promise.all([
      this.botMessageService.getSafe(session.data.clinicId, MessageKey.SELECT_TIME, {}, session.data.language, 'Please choose a time:'),
      this.botMessageService.getSafe(session.data.clinicId, MessageKey.HEADER_TIMES, {}, session.data.language, 'Available Times'),
      this.botMessageService.getSafe(session.data.clinicId, MessageKey.HEADER_SELECT_TIME, {}, session.data.language, 'Select a time'),
    ]);

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

  async showDateList(
    phone: string,
    session: Session,
  ): Promise<void> {
    const availableDates = await this.availabilityService.getAvailableDates(session.data.doctorName!, 3);

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
      availableDates.map((item) => ({
        id: `date_${item.date}`,
        title: formatDateButtonLabel(item.date, session.data.language),
      })),
    );
  }

  private async resolveDate(text: string, doctorName: string): Promise<string | null> {
    const trimmed = text.trim();

    if (trimmed.startsWith('date_')) {
      const candidate = trimmed.replace('date_', '');
      if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
        return candidate;
      }
      return null;
    }

    const index = parseInt(trimmed, 10);
    if (!isNaN(index) && index >= 1) {
      const availableDates = await this.availabilityService.getAvailableDates(doctorName, 3);
      if (index <= availableDates.length) {
        return availableDates[index - 1].date;
      }
    }

    return null;
  }
}
