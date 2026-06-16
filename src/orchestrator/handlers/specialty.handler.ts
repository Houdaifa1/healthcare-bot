import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionsService } from '../../sessions/sessions.service';
import { SpecialtyService } from '../../bot-content/specialty.service';
import { DoctorService } from '../../bot-content/doctor.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { MessageKey } from '@prisma/client';
import { Specialty } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AiService, Intent } from '../../ai/ai.service';

@Injectable()
export class SpecialtyHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly specialtyService: SpecialtyService,
    private readonly doctorService: DoctorService,
    private readonly botMessageService: BotMessageService,
    private readonly prisma: PrismaService,
    private readonly aiService: AiService,
  ) { }

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
      const message = await this.botMessageService.getSafe(
        session.data.clinicId,
        MessageKey.NO_SPECIALTIES_AVAILABLE,
        {},
        session.data.language,
        'No specialties are available right now.',
      );
      await this.whatsappService.sendText(phone, message);
      session.state = SessionState.IDLE;
      await this.sessionsService.save(session);
      await this.showWelcomeMenu(phone, session);
      return;
    }

    const message = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.SELECT_SPECIALTY,
      {},
      session.data.language,
      'Please choose your specialty:',
    );

    const header = await this.botMessageService.getSafe(session.data.clinicId, MessageKey.HEADER_SPECIALTIES, {}, session.data.language, 'Specialties');
    await this.whatsappService.sendInteractiveList(
      phone,
      header,
      message,
      header,
      [
        {
          title: '',
          rows: specialties.map((s) => {
            const labels = s.labels as Record<string, string> | null;
            const label = labels?.[session.data.language] ?? labels?.['FR'] ?? s.slug;
            return {
              id: `specialty_${s.slug}`,
              title: label,
            };
          }),
        },
      ],
    );
  }

  /**
   * Called by OrchestratorService when the session state is BOOKING_SPECIALTY
   * and a new message arrives.
   */
  async handle(phone: string, text: string, session: Session): Promise<void> {
    const trimmed = text.trim().toLowerCase();

    // Allow returning to main menu from any booking step
    if (trimmed === 'menu') {
      session.state = SessionState.IDLE;
      session.data.languageConfirmed = false;
      await this.sessionsService.save(session);
      await this.showWelcomeMenu(phone, session);
      return;
    }
    const specialties = await this.specialtyService.findActive(
      session.data.clinicId,
      session.data.language,
    );

    if (specialties.length === 0) {
      const message = await this.botMessageService.getSafe(
        session.data.clinicId,
        MessageKey.NO_SPECIALTIES_AVAILABLE,
        {},
        session.data.language,
        'No specialties are available right now.',
      );
      await this.whatsappService.sendText(phone, message);
      session.state = SessionState.IDLE;
      await this.sessionsService.save(session);
      await this.showWelcomeMenu(phone, session);
      return;
    }

    const specialty = this.resolveSpecialty(text, specialties);

    if (!specialty) {
      // Run intent detection — user might want to cancel, go to menu, or talk to agent
      const intent = await this.aiService.detectIntent(text, session.state, session.data.language);

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
        // delegate to handoff flow inline
        const message = await this.botMessageService.getSafe(
          session.data.clinicId, MessageKey.HANDOFF_TRIGGERED, {}, session.data.language, 'Connecting you with our team.'
        );
        await this.whatsappService.sendText(phone, message);
        return;
      }

      // UNKNOWN or anything else — reshow the specialty list
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

    // BUG 7: No doctors for specialty → send specific message, go to IDLE, show menu
    if (doctors.length === 0) {
      const message = await this.botMessageService.getSafe(
        session.data.clinicId,
        MessageKey.NO_DOCTORS_FOR_SPECIALTY,
        {},
        session.data.language,
        'No doctors are currently available for this specialty.',
      );
      await this.whatsappService.sendText(phone, message);
      session.state = SessionState.IDLE;
      await this.sessionsService.save(session);
      await this.showWelcomeMenu(phone, session);
      return;
    }

    const labels = specialty.labels as Record<string, string> | null;
    const specialtyLabel = labels?.[session.data.language] ?? labels?.['FR'] ?? specialty.slug;

    const message = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.SELECT_DOCTOR,
      { specialty: specialtyLabel },
      session.data.language,
      'Here are the available doctors:',
    );

    const headerDoctors = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.HEADER_DOCTORS,
      {},
      session.data.language,
      'Doctors',
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

  async showWelcomeMenu(phone: string, session: Session): Promise<void> {
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

    const btnBook = await this.botMessageService.getSafe(session.data.clinicId, MessageKey.BUTTON_BOOK_APP, {}, session.data.language, 'Book appointment');
    const btnFaq = await this.botMessageService.getSafe(session.data.clinicId, MessageKey.BUTTON_FAQ, {}, session.data.language, 'FAQ');
    const btnAgent = await this.botMessageService.getSafe(session.data.clinicId, MessageKey.BUTTON_AGENT, {}, session.data.language, 'Talk to agent');
    await this.whatsappService.sendButtons(phone, message, [
      { id: 'book_appointment', title: btnBook },
      { id: 'faq', title: btnFaq },
      { id: 'human_agent', title: btnAgent },
    ]);
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

    // Label match (case-insensitive, accent-tolerant) — checks both FR and EN labels
    const normalised = trimmed.toLowerCase();
    return specialties.find((s) => {
      const labels = s.labels as Record<string, string> | null;
      if (!labels) return false;
      for (const label of Object.values(labels)) {
        if (label?.toLowerCase() === normalised) return true;
      }
      return false;
    }) ?? null;
  }
}