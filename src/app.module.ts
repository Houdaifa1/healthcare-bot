import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from '@platform/config/configuration';
import { PrismaModule } from '@platform/database/prisma.module';
import { SessionsModule } from '@platform/cache/sessions.module';
import { QueueModule } from '@platform/queue/queue.module';
import { AuthModule } from '@platform/auth/auth.module';
import { WhatsAppModule } from '@integrations/whatsapp/whatsapp.module';
import { ClinOpsModule } from '@integrations/clinops/clinops.module';
import { ClinicModule } from '@operations/clinic/clinic.module';
import { BotMessagesModule } from '@operations/clinic/bot-messages/bot-messages.module';
import { FaqsModule } from '@operations/clinic/faqs/faqs.module';
import { CampaignModule } from '@operations/campaigns/campaign.module';
import { ComplaintsModule } from '@operations/complaints/complaints.module';
import { BookingRequestsModule } from '@operations/bookings/booking-requests.module';
import { OrchestratorModule } from '@conversation/inbound/orchestrator.module';
import { InboundModule } from '@conversation/inbound/inbound.module';
import { OutboundModule } from '@conversation/outbound/outbound.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal:    true,
      load:        [configuration],
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),

    // ── platform ──
    PrismaModule,
    SessionsModule,
    QueueModule,
    AuthModule,

    // ── integrations ──
    WhatsAppModule,
    ClinOpsModule,

    // ── operations ──
    ClinicModule,
    BotMessagesModule,
    FaqsModule,
    CampaignModule,
    ComplaintsModule,
    BookingRequestsModule,

    // ── conversation ──
    OrchestratorModule,
    InboundModule,
    OutboundModule,
  ],
})
export class AppModule {}
