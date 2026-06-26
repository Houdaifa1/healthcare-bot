import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CampaignService } from './campaign.service';
import { CampaignSchedulerService } from './campaign-scheduler.service';
import { CampaignController } from './campaign.controller';
import { OutboundProcessor } from './outbound.processor';
import { ConversationService } from './conversation.service';
import { ReminderService } from './reminder.service';
import { ClinOpsModule } from '../clinops/clinops.module';
import { SessionsModule } from '../sessions/sessions.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { QUEUES } from '../queue/queue.constants';

// ScheduleModule.forRoot() is registered in AppModule — no need to register
// it again here. Duplicate registration causes NestJS to ignore the second
// one silently, but it's cleaner to keep a single registration at root.

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUES.CAMPAIGN_OUTBOUND }),
    ClinOpsModule,
    SessionsModule,
    WhatsAppModule,
  ],
  controllers: [CampaignController],
  providers: [
    CampaignService,
    CampaignSchedulerService,
    OutboundProcessor,
    ConversationService,
    ReminderService,
  ],
  exports: [CampaignService, ConversationService],
})
export class CampaignModule {}