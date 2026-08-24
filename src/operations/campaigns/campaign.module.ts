import { Module } from '@nestjs/common';
import { CampaignService } from './campaign.service';
import { CampaignSchedulerService } from './campaign-scheduler.service';
import { CampaignController } from './campaign.controller';
import { QueueModule } from '@platform/queue/queue.module';
import { SessionsModule } from '@platform/cache/sessions.module';
import { ClinOpsModule } from '@integrations/clinops/clinops.module';
import { WhatsAppModule } from '@integrations/whatsapp/whatsapp.module';
import { HandoffModule } from '@operations/handoff/handoff.module';

// ScheduleModule.forRoot() is registered in AppModule — no need to register
// it again here. Duplicate registration causes NestJS to ignore the second
// one silently, but it's cleaner to keep a single registration at root.
//
// Campaign management only: CRUD, launch/stop lifecycle and scheduling. The
// AI turn loop, opening-message worker and reminder cron moved to
// conversation/outbound — they are queue-triggered, not staff-triggered.
@Module({
  imports: [
    QueueModule,
    ClinOpsModule,
    SessionsModule,
    WhatsAppModule,
    HandoffModule,
  ],
  controllers: [CampaignController],
  providers: [
    CampaignService,
    CampaignSchedulerService,
  ],
  exports: [CampaignService],
})
export class CampaignModule {}
