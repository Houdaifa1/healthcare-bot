import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MessageProcessor } from './message.processor';
import { QUEUES } from './queue.constants';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { SessionsModule } from '../sessions/sessions.module';
import { CampaignModule } from '../campaign/campaign.module';
import { HandoffModule } from '../handoff/handoff.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUES.MESSAGES }),
    OrchestratorModule,
    SessionsModule,
    CampaignModule,
    HandoffModule,
    WhatsAppModule,
  ],
  providers: [MessageProcessor],
  exports:   [BullModule],
})
export class QueueModule {}