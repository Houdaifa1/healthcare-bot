import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AiModule } from '../ai/ai.module';
import { ClinOpsModule } from '../clinops/clinops.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { BotMessageService } from './bot-message.service';
import { LanguageDetectionService } from './language-detection.service';
import { SpecialtyService } from './specialty.service';
import { DoctorService } from './doctor.service';
import { FAQService } from './faq.service';
import { AvailabilityService } from './availability.service';
import { WelcomeMenuService } from './welcome-menu.service';
import { LanguagePromptService } from './language-prompt.service';

@Module({
  imports: [PrismaModule, AiModule, ClinOpsModule, WhatsAppModule],
  providers: [
    BotMessageService,
    LanguageDetectionService,
    SpecialtyService,
    DoctorService,
    FAQService,
    AvailabilityService,
    WelcomeMenuService,
    LanguagePromptService,
  ],
  exports: [
    BotMessageService,
    LanguageDetectionService,
    SpecialtyService,
    DoctorService,
    FAQService,
    AvailabilityService,
    WelcomeMenuService,
    LanguagePromptService,
  ],
})
export class BotContentModule {}
