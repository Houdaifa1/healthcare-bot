import { Module } from '@nestjs/common';
import { OrchestratorService } from './orchestrator.service';
import { SessionsModule } from '@platform/cache/sessions.module';
import { WhatsAppModule } from '@integrations/whatsapp/whatsapp.module';
import { BotContentModule } from '@conversation/content/bot-content.module';
import { HandoffModule } from '@operations/handoff/handoff.module';
import { AiModule } from '@conversation/nlu/ai.module';
import { PrismaModule } from '@platform/database/prisma.module';
import { ClinOpsModule } from '@integrations/clinops/clinops.module';
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