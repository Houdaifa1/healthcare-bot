import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { intentDetectionPrompt } from './prompts/intent-detection.prompt';
import { languageDetectionPrompt } from './prompts/language-detection.prompt';

export enum Intent {
  BOOK_APPOINTMENT = 'BOOK_APPOINTMENT',
  ASK_FAQ = 'ASK_FAQ',
  HUMAN_AGENT = 'HUMAN_AGENT',
  CONFIRM = 'CONFIRM',
  CANCEL = 'CANCEL',
  GREETING = 'GREETING',
  UNKNOWN = 'UNKNOWN',
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private model!: GenerativeModel;
  private isEnabled = false;

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('ai.apiKey');
    if (apiKey) {
      const genAI = new GoogleGenerativeAI(apiKey);
      this.model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash-lite',
      });
      this.isEnabled = true;
      this.logger.log('Gemini AI initialized successfully');
    } else {
      this.logger.warn('GEMINI_API_KEY not set — using keyword fallback only');
    }
  }

  async detectIntent(
    userMessage: string,
    state: string,
    language: string,
  ): Promise<Intent> {
    if (!this.isEnabled) {
      return this.fallbackIntentDetection(userMessage);
    }

    try {
      const prompt = intentDetectionPrompt(userMessage, state, language);
      const result = await this.model.generateContent(prompt);
      const response = result.response.text().trim().toUpperCase();

      this.logger.log(`Gemini intent: "${response}" for: "${userMessage}"`);

      if (Object.values(Intent).includes(response as Intent)) {
        return response as Intent;
      }

      this.logger.warn(`Gemini returned unknown intent: "${response}" — using fallback`);
      return this.fallbackIntentDetection(userMessage);
    } catch (error) {
      this.logger.error('Gemini intent detection failed', error.message);
      return this.fallbackIntentDetection(userMessage);
    }
  }

  async detectLanguage(userMessage: string): Promise<'FR' | 'EN' | 'UNKNOWN'> {
    if (!this.isEnabled) return 'UNKNOWN';

    try {
      const prompt = languageDetectionPrompt(userMessage);
      const result = await this.model.generateContent(prompt);
      const response = result.response.text().trim().toUpperCase();

      this.logger.log(`Gemini language: "${response}" for: "${userMessage}"`);

      if (response === 'FR' || response === 'EN') return response;
      return 'UNKNOWN';
    } catch (error) {
      this.logger.error('Gemini language detection failed', error.message);
      return 'UNKNOWN';
    }
  }

  private fallbackIntentDetection(message: string): Intent {
    const lower = message.toLowerCase().trim();

    if (/^(bonjour|hello|hi|salut|hey|bonsoir)/i.test(lower)) return Intent.GREETING;
    if (/(rdv|rendez-vous|réserv|book|appointment|prendre|schedule|consulter|medecin|doctor)/i.test(lower)) return Intent.BOOK_APPOINTMENT;
    if (/(horaire|heure|adresse|prix|tarif|coût|où|quand|ouvert|fermé|time|open|close|location)/i.test(lower)) return Intent.ASK_FAQ;
    if (/(agent|humain|human|operator|personne|parler|speak|talk|someone)/i.test(lower)) return Intent.HUMAN_AGENT;
    if (/^(oui|yes|confirm|confirmer|d'accord|ok|yep|sure)/i.test(lower)) return Intent.CONFIRM;
    if (/^(non|no|cancel|annuler|quitter|stop|nope)/i.test(lower)) return Intent.CANCEL;

    return Intent.UNKNOWN;
  }
}