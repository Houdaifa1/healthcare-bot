import { Module } from '@nestjs/common';
import { PrismaModule } from '@platform/database/prisma.module';
import { AiModule } from '@conversation/nlu/ai.module';
import { ClinOpsModule } from '@integrations/clinops/clinops.module';
import { WhatsAppModule } from '@integrations/whatsapp/whatsapp.module';
import { MessageTemplateService } from './message-template.service';
import { SpecialtyService } from './specialty.service';
import { DoctorService } from './doctor.service';
import { FaqContentService } from './faq-content.service';
import { AvailabilityService } from './availability.service';
import { WelcomeMenuService } from './welcome-menu.service';
import { LanguagePromptService } from './language-prompt.service';

@Module({
  imports: [PrismaModule, AiModule, ClinOpsModule, WhatsAppModule],
  providers: [
    MessageTemplateService,
    SpecialtyService,
    DoctorService,
    FaqContentService,
    AvailabilityService,
    WelcomeMenuService,
    LanguagePromptService,
  ],
  exports: [
    MessageTemplateService,
    SpecialtyService,
    DoctorService,
    FaqContentService,
    AvailabilityService,
    WelcomeMenuService,
    LanguagePromptService,
  ],
})
export class BotContentModule {}
