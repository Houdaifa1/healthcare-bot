import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Session, SessionState } from '../sessions/sessions.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  IdleHandler,
  LanguageSelectHandler,
  NameHandler,
  SpecialtyHandler,
  DoctorHandler,
  DateHandler,
  TimeHandler,
  ConfirmHandler,
  FaqHandler,
  HandoffHandler,
} from './handlers';

@Injectable()
export class OrchestratorService implements OnModuleInit {
  private readonly logger = new Logger(OrchestratorService.name);
  private handlers = new Map<SessionState, any>();

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly sessionsService: SessionsService,
  ) {}

  onModuleInit() {
    this.registerHandlers();
  }

  private registerHandlers() {
    const handlerClasses: [SessionState, any][] = [
      [SessionState.IDLE, IdleHandler],
      [SessionState.LANGUAGE_SELECT, LanguageSelectHandler],
      [SessionState.AWAITING_NAME, NameHandler],
      [SessionState.BOOKING_SPECIALTY, SpecialtyHandler],
      [SessionState.BOOKING_DOCTOR, DoctorHandler],
      [SessionState.BOOKING_DATE, DateHandler],
      [SessionState.BOOKING_TIME, TimeHandler],
      [SessionState.BOOKING_CONFIRM, ConfirmHandler],
      [SessionState.FAQ_BROWSING, FaqHandler],
      [SessionState.AWAITING_HANDOFF, HandoffHandler],
    ];

    for (const [state, handlerClass] of handlerClasses) {
      const handlerInstance = this.moduleRef.get(handlerClass, { strict: false });
      this.handlers.set(state, handlerInstance);
    }

    this.logger.log(`Registered ${this.handlers.size} state handlers.`);
  }

  async handleMessage(phone: string, text: string, session: Session): Promise<void> {
    const handler = this.handlers.get(session.state);
    if (handler) {
      this.logger.log(
        `Handling message for ${phone} in state ${session.state}`,
      );
      await handler.handle(phone, text, session);
    } else {
      this.logger.error(
        `No handler found for state: ${session.state} for ${phone}`,
      );
    }
  }

  async transition(
    session: Session,
    newState: SessionState,
  ): Promise<void> {
    this.logger.log(
      `Transitioning ${session.phone} from ${session.state} to ${newState}`,
    );
    session.state = newState;
    await this.sessionsService.save(session);
  }
}