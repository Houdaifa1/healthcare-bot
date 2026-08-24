import { Module } from '@nestjs/common';
import { IntentClassifierService } from './intent-classifier.service';
import { LanguageDetectionService } from './language-detection.service';

@Module({
  providers: [IntentClassifierService, LanguageDetectionService],
  exports: [IntentClassifierService, LanguageDetectionService],
})
export class AiModule {}
