import { Module } from '@nestjs/common';
import { OrchestratorService } from './orchestrator.service';
import { SessionsModule } from '../sessions/sessions.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { BotContentModule } from '../bot-content/bot-content.module';
import { HandoffModule } from '../handoff/handoff.module';
import { AiModule } from '../ai/ai.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ClinOpsModule } from '../clinops/clinops.module';
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
import { BookingNavigationHelper } from './handlers/booking-navigation.helper';

@Module({
  imports: [
    SessionsModule,
    WhatsAppModule,
    BotContentModule,
    HandoffModule,
    AiModule,
    PrismaModule,
    ClinOpsModule,
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
    BookingNavigationHelper,
  ],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}