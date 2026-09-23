import { Injectable } from '@nestjs/common';
import { MessageKey, Language } from '@prisma/client';
import { Session, SessionState, SessionsService } from '@platform/cache/sessions.service';
import { WhatsAppService } from '@integrations/whatsapp/whatsapp.service';
import { MessageTemplateService } from '@conversation/content/message-template.service';
import { SpecialtyHandler } from './specialty.handler';
import { BookingNavigationHelper } from './booking-navigation.helper';
import { HandoffHandler } from './handoff.handler';

const EMERGENCY_PATTERN = /\b(chest pain|can't breathe|cannot breathe|difficulty breathing|stroke|unconscious|severe bleeding|suicidal|emergency|douleur thoracique|difficulte a respirer|difficulté à respirer|saignement abondant|inconscient|urgence|avc)\b|ألم في الصدر|ضيق التنفس|نزيف شديد|انتحار|طارئ/i;

@Injectable()
export class ReasonHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly botMessageService: MessageTemplateService,
    private readonly specialtyHandler: SpecialtyHandler,
    private readonly nav: BookingNavigationHelper,
    private readonly handoffHandler: HandoffHandler,
  ) {}

  async showReasonPrompt(phone: string, session: Session): Promise<void> {
    const fallback = session.data.language === Language.EN
      ? 'What is the reason for your appointment? A brief description is enough. For an emergency, call local emergency services now.'
      : "Quel est le motif de votre rendez-vous ? Une brève description suffit. En cas d'urgence, appelez immédiatement les services d'urgence.";
    const message = await this.botMessageService.getSafe(
      session.data.clinicId, MessageKey.ASK_REASON, {}, session.data.language, fallback,
    );
    await this.whatsappService.sendText(phone, message);
  }

  async handle(phone: string, text: string, session: Session): Promise<void> {
    if (await this.nav.handleMenuCommand(phone, text, session)) return;
    if (EMERGENCY_PATTERN.test(text)) {
      const urgentMessage = session.data.language === Language.EN
        ? 'This may need urgent care. Call local emergency services now. I am also alerting our team; do not wait for a booking reply.'
        : "Cela peut nécessiter des soins urgents. Appelez les services d'urgence maintenant. J'alerte aussi notre équipe ; n'attendez pas la confirmation d'un rendez-vous.";
      await this.whatsappService.sendText(phone, urgentMessage);
      await this.handoffHandler.handle(phone, text, session);
      return;
    }
    if (await this.nav.handleUnresolvedSelection(phone, text, session)) return;

    const reason = text.trim();
    if (reason.length < 3 || reason.length > 250) {
      await this.showReasonPrompt(phone, session);
      return;
    }

    session.data.reason = reason;
    session.state = SessionState.BOOKING_SPECIALTY;
    await this.sessionsService.save(session);
    await this.specialtyHandler.showSpecialtyList(phone, session);
  }
}
