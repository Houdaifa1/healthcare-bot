import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '@platform/cache/sessions.service';
import { WhatsAppService } from '@integrations/whatsapp/whatsapp.service';
import { SessionsService } from '@platform/cache/sessions.service';
import { MessageTemplateService } from '@conversation/content/message-template.service';
import { HandoffService } from '@operations/handoff/handoff.service';
import { MessageKey, BookingSource } from '@prisma/client';
import { WelcomeMenuService } from '@conversation/content/welcome-menu.service';

@Injectable()
export class HandoffHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly botMessageService: MessageTemplateService,
    private readonly handoffService: HandoffService,
    private readonly welcomeMenuService: WelcomeMenuService,
  ) { }

  async handle(phone: string, text: string, session: Session): Promise<void> {
    if (session.state === SessionState.AWAITING_HANDOFF) {
      // User tapped Menu button — escape handoff, reset to IDLE
      if (text.trim().toLowerCase() === 'menu') {
        session.state = SessionState.IDLE;
        session.data.languageConfirmed = false;
        await this.sessionsService.save(session);
        await this.welcomeMenuService.show(phone, session);
        return;
      }

      // Any other follow-up message — remind them and show menu button
      const [message, btnMenu] = await Promise.all([
        this.botMessageService.getSafe(
          session.data.clinicId,
          MessageKey.HANDOFF_WAITING,
          {},
          session.data.language,
          'An agent will be with you shortly. Tap the button to return to the menu.',
        ),
        this.botMessageService.getSafe(
          session.data.clinicId,
          MessageKey.BUTTON_MENU,
          {},
          session.data.language,
          'Menu',
        ),
      ]);
      await this.whatsappService.sendButtons(phone, message, [{ id: 'menu', title: btnMenu }]);
      return;
    }

    // First trigger: set state, notify patient, create the dashboard-visible
    // handoff and alert staff — same path and same admin notification format
    // the campaign/outbound flow uses.
    session.state = SessionState.AWAITING_HANDOFF;
    await this.sessionsService.save(session);

    const message = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.HANDOFF_TRIGGERED,
      {},
      session.data.language,
      'Connecting you with our team. An agent will reply shortly.',
    );
    await this.whatsappService.sendText(phone, message);

    await this.handoffService.createHandoff({
      clinicId: session.data.clinicId,
      source: BookingSource.INBOUND,
      phone,
      patientName: session.data.patientName,
      reason: text,
      language: session.data.language,
    });
  }
}