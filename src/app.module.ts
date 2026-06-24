import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';
import { QueueModule } from './queue/queue.module';
import { SessionsModule } from './sessions/sessions.module';
import { OrchestratorModule } from './orchestrator/orchestrator.module';
import { AdminModule } from './admin/admin.module';
import { CommonModule } from './common/common.module';
import { ClinOpsModule } from './clinops/clinops.module';
import { CampaignModule } from './campaign/campaign.module';
import { ComplaintsModule } from './complaints/complaints.module';
import { BookingRequestsModule } from './booking-requests/booking-requests.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal:    true,
      load:        [configuration],
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    CommonModule,
    SessionsModule,
    OrchestratorModule,
    QueueModule,
    WhatsAppModule,
    AdminModule,
    ClinOpsModule,
    CampaignModule,
    ComplaintsModule,
    BookingRequestsModule,
  ],
})
export class AppModule {}
