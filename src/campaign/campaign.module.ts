import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { CampaignService } from './campaign.service';
import { CampaignController } from './campaign.controller';
import { OutboundProcessor } from './outbound.processor';
import { ConversationService } from './conversation.service';
import { ReminderService } from './reminder.service';
import { CampaignSchedulerService } from './campaign-scheduler.service';
import { ClinOpsModule } from '../clinops/clinops.module';
import { SessionsModule } from '../sessions/sessions.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { QUEUES } from '../queue/queue.constants';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    BullModule.registerQueue({ name: QUEUES.CAMPAIGN_OUTBOUND }),
    ClinOpsModule,
    SessionsModule,
    WhatsAppModule,
  ],
  controllers: [CampaignController],
  providers: [
    CampaignService,
    OutboundProcessor,
    ConversationService,
    ReminderService,
    CampaignSchedulerService,
  ],
  exports: [CampaignService, ConversationService],
})
export class CampaignModule {}