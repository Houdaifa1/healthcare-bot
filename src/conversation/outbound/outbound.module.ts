import { Module } from '@nestjs/common';
import { ConversationService } from './conversation.service';
import { OutboundProcessor } from './outbound.processor';
import { ReminderService } from './reminder.service';
import { OllamaProvider } from '@integrations/llm/ollama.provider';
import { QueueModule } from '@platform/queue/queue.module';
import { SessionsModule } from '@platform/cache/sessions.module';
import { HandoffModule } from '@operations/handoff/handoff.module';
import { WhatsAppModule } from '@integrations/whatsapp/whatsapp.module';

// The patient-facing half of the former CampaignModule: the AI turn loop, the
// opening-message worker and the reminder cron. Campaign *management* (staff
// CRUD, launch/stop, targeting) stayed behind in operations/campaigns — the two
// halves have different triggers and only ever communicate through BullMQ.
//
// This split is required, not cosmetic: leaving these providers registered in
// operations/campaigns would make an operations module import conversation,
// which is the upward dependency the layering forbids.
@Module({
  imports: [
    QueueModule,
    SessionsModule,
    HandoffModule,
    WhatsAppModule,
  ],
  providers: [
    ConversationService,
    OutboundProcessor,
    ReminderService,
    OllamaProvider,
  ],
  exports: [ConversationService],
})
export class OutboundModule {}
