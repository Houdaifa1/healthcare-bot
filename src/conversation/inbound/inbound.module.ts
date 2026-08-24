import { Module } from '@nestjs/common';
import { MessageProcessor } from './message.processor';
import { OrchestratorModule } from './orchestrator.module';
import { QueueModule } from '@platform/queue/queue.module';
import { SessionsModule } from '@platform/cache/sessions.module';
import { OutboundModule } from '@conversation/outbound/outbound.module';
import { HandoffModule } from '@operations/handoff/handoff.module';
import { WhatsAppModule } from '@integrations/whatsapp/whatsapp.module';

// The consumer half of the former QueueModule: it owns MessageProcessor, the
// QUEUES.MESSAGES worker. The queue itself is declared in platform/queue —
// this module only consumes it. Splitting the two is what lets the queue
// infrastructure sit in layer 1 while its consumer stays here in layer 4.
@Module({
  imports: [
    QueueModule,
    OrchestratorModule,
    SessionsModule,
    OutboundModule,
    HandoffModule,
    WhatsAppModule,
  ],
  providers: [MessageProcessor],
})
export class InboundModule {}
