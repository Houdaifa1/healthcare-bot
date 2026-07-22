import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionsService } from '../../sessions/sessions.service';
import { AvailabilityService } from '../../bot-content/availability.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { MessageKey } from '@prisma/client';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { PrismaService } from '../../prisma/prisma.service';
import { AiService, Intent } from '../../ai/ai.service';

@Injectable()
export class DateHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly availabilityService: AvailabilityService,
    private readonly botMessageService: BotMessageService,
    private readonly prisma: PrismaService,
    private readonly aiService: AiService,
  ) {}

  async handle(phone: string, text: string, session: Session): Promise<void> {
    const trimmed = text.trim().toLowerCase();

    if (trimmed === 'menu') {
      session.state = SessionState.IDLE;
      session.data.languageConfirmed = false;
      await this.sessionsService.save(session);
      await this.showWelcomeMenu(phone, session);
      return;
    }

    const doctorId = session.data.doctorId;
    if (!doctorId) {
      const msg = await this.botMessageService.getSafe(
        session.data.clinicId,
        MessageKey.ERROR_MISSING_DOCTOR,
        {},
        session.data.language,
        'Missing doctor. Please start over.',
      );
      await this.whatsappService.sendText(phone, msg);
      await this.sessionsService.reset(phone);
      return;
    }

    const date = await this.resolveDate(text, doctorId);

    if (!date) {
      const intent = await this.aiService.detectIntent(
        text,
        session.state,
        session.data.language,
      );

      if (intent === Intent.CANCEL || intent === Intent.GREETING) {
        session.state = SessionState.IDLE;
        session.data.languageConfirmed = false;
        await this.sessionsService.save(session);
        await this.showWelcomeMenu(phone, session);
        return;
      }

      if (intent === Intent.HUMAN_AGENT) {
        session.state = SessionState.AWAITING_HANDOFF;
        await this.sessionsService.save(session);
        const message = await this.botMessageService.getSafe(
          session.data.clinicId,
          MessageKey.HANDOFF_TRIGGERED,
          {},
          session.data.language,
          'Connecting you with our team.',
        );
        await this.whatsappService.sendText(phone, message);
        return;
      }

      await this.showDateList(phone, session, doctorId);
      return;
    }

    session.data.selectedDate = date;
    session.state = SessionState.BOOKING_TIME;
    await this.sessionsService.save(session);

    const availableSlots = await this.availabilityService.getAvailableSlots(
      doctorId,
      date,
    );

    if (availableSlots.length === 0) {
      const message = await this.botMessageService.getSafe(
        session.data.clinicId,
        MessageKey.NO_SLOTS_AVAILABLE,
        {},
        session.data.language,
        'No slots available.',
      );
      await this.whatsappService.sendText(phone, message);
      session.state = SessionState.BOOKING_DATE;
      await this.sessionsService.save(session);
      await this.showDateList(phone, session, doctorId);
      return;
    }

    const message = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.SELECT_TIME,
      {},
      session.data.language,
      'Please choose a time:',
    );

    const headerTimes = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.HEADER_TIMES,
      {},
      session.data.language,
      'Available Times',
    );
    const headerSelectTime = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.HEADER_SELECT_TIME,
      {},
      session.data.language,
      'Select a time',
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
        session.data.clinicId,
        MessageKey.NO_SLOTS_AVAILABLE,
        {},
        session.data.language,
        'No slots available.',
      );
      await this.whatsappService.sendText(phone, message);
      session.state = SessionState.BOOKING_DOCTOR;
      await this.sessionsService.save(session);
      return;
    }

    const message = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.SELECT_DATE,
      {},
      session.data.language,
      'Please choose a date:',
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

  private async resolveDate(
    text: string,
    doctorId: string,
  ): Promise<string | null> {
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

  private async showWelcomeMenu(
    phone: string,
    session: Session,
  ): Promise<void> {
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: session.data.clinicId },
      select: { name: true },
    });

    const message = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.WELCOME,
      { clinicName: clinic?.name ?? '' },
      session.data.language,
      'Welcome! How can I help you?',
    );

    const btnBook = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.BUTTON_BOOK_APP,
      {},
      session.data.language,
      'Book appointment',
    );
    const btnFaq = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.BUTTON_FAQ,
      {},
      session.data.language,
      'FAQ',
    );
    const btnAgent = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.BUTTON_AGENT,
      {},
      session.data.language,
      'Talk to agent',
    );
    await this.whatsappService.sendButtons(phone, message, [
      { id: 'book_appointment', title: btnBook },
      { id: 'faq', title: btnFaq },
      { id: 'human_agent', title: btnAgent },
    ]);
  }
}
