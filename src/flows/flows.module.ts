import { Module } from '@nestjs/common';
import { FlowsService } from './flows.service';
import { FlowEngineService } from './flow-engine.service';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { SessionsModule } from '../sessions/sessions.module';
import { BotContentModule } from '../bot-content/bot-content.module';
import { AppointmentsModule } from '../appointments/appointments.module';

@Module({
  imports: [
    PrismaModule,
    WhatsAppModule,
    SessionsModule,
    BotContentModule,
    AppointmentsModule,
  ],
  providers: [FlowsService, FlowEngineService],
  exports: [FlowsService, FlowEngineService],
})
export class FlowsModule {}