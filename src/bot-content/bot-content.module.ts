import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BotMessageService } from './bot-message.service';
import { LanguageDetectionService } from './language-detection.service';
import { SpecialtyService } from './specialty.service';
import { DoctorService } from './doctor.service';
import { FAQService } from './faq.service';
import { AvailabilityService } from './availability.service';

@Module({
  imports: [PrismaModule],
  providers: [
    BotMessageService,
    LanguageDetectionService,
    SpecialtyService,
    DoctorService,
    FAQService,
    AvailabilityService,
  ],
  exports: [
    BotMessageService,
    LanguageDetectionService,
    SpecialtyService,
    DoctorService,
    FAQService,
    AvailabilityService,
  ],
})
export class BotContentModule {}
