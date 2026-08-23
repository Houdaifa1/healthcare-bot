import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { SessionsService } from '../../sessions/sessions.service';
import { WelcomeMenuService } from '../../bot-content/welcome-menu.service';
import { AiService, Intent } from '../../ai/ai.service';
import { HandoffHandler } from './handoff.handler';

// Shared "where do I bail out to" logic every mid-booking handler
// (specialty/doctor/date/time) needs, extracted so all of them behave
// identically instead of six copies drifting apart over time.
@Injectable()
export class BookingNavigationHelper {
  constructor(
    private readonly sessionsService: SessionsService,
    private readonly welcomeMenuService: WelcomeMenuService,
    private readonly handoffHandler: HandoffHandler,
    private readonly aiService: AiService,
  ) {}

  /**
   * Handles the explicit "menu" escape hatch. Returns true if it was
   * handled — the caller should return immediately in that case.
   */
  async handleMenuCommand(phone: string, text: string, session: Session): Promise<boolean> {
    if (text.trim().toLowerCase() !== 'menu') return false;

    session.state = SessionState.IDLE;
    session.data.languageConfirmed = false;
    await this.sessionsService.save(session);
    await this.welcomeMenuService.show(phone, session);
    return true;
  }

  /**
   * For a booking-step handler that couldn't resolve the patient's raw input
   * as a valid selection: detects whether it was actually a CANCEL/GREETING
   * (→ back to menu) or HUMAN_AGENT request (→ handoff) in disguise.
   * Returns true if handled (caller should return immediately); false means
   * the caller should fall back to re-showing its own options list.
   */
  async handleUnresolvedSelection(phone: string, text: string, session: Session): Promise<boolean> {
    const intent = await this.aiService.detectIntent(text, session.state, session.data.language);

    if (intent === Intent.CANCEL || intent === Intent.GREETING) {
      session.state = SessionState.IDLE;
      session.data.languageConfirmed = false;
      await this.sessionsService.save(session);
      await this.welcomeMenuService.show(phone, session);
      return true;
    }

    if (intent === Intent.HUMAN_AGENT) {
      await this.handoffHandler.handle(phone, text, session);
      return true;
    }

    return false;
  }
}
