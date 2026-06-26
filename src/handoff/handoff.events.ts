import { Injectable, Logger } from '@nestjs/common';
import { Subject } from 'rxjs';

export interface HandoffEvent {
  type: 'new_message' | 'session_resolved' | 'new_session';
  phone: string;
  timestamp: number;
}

@Injectable()
export class HandoffEventsService {
  private readonly logger = new Logger(HandoffEventsService.name);
  private eventsSubject = new Subject<HandoffEvent>();

  /** Observable for SSE stream */
  readonly events$ = this.eventsSubject.asObservable();

  emit(event: HandoffEvent): void {
    this.logger.log(`Emitting handoff event: ${event.type} for ${event.phone}`);
    this.eventsSubject.next(event);
  }
}