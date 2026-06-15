import { Module } from '@nestjs/common';
import { OrchestratorService } from './orchestrator.service';
import { SessionsModule } from '../sessions/sessions.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { BotContentModule } from '../bot-content/bot-content.module';
import { HandoffModule } from '../handoff/handoff.module';
import { AppointmentsModule } from '../appointments/appointments.module';
import { AiModule } from '../ai/ai.module';
import { PrismaModule } from '../prisma/prisma.module';
import {
  IdleHandler,
  LanguageSelectHandler,
  NameHandler,
  SpecialtyHandler,
  DoctorHandler,
  DateHandler,
  TimeHandler,
  ConfirmHandler,
  FaqHandler,
  HandoffHandler,
} from './handlers';

@Module({
  imports: [
    SessionsModule,
    WhatsAppModule,
    BotContentModule,
    HandoffModule,
    AppointmentsModule,
    AiModule,
    PrismaModule, // needed by handlers to fetch clinic name
  ],
  providers: [
    OrchestratorService,
    IdleHandler,
    LanguageSelectHandler,
    NameHandler,
    SpecialtyHandler,
    DoctorHandler,
    DateHandler,
    TimeHandler,
    ConfirmHandler,
    FaqHandler,
    HandoffHandler,
  ],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}