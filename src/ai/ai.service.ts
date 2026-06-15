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
    // Always run fallback first — it handles unambiguous cases instantly
    // and saves Gemini quota for truly ambiguous messages.
    const fallback = this.fallbackIntentDetection(userMessage, state);
    if (fallback !== Intent.UNKNOWN) {
      this.logger.log(`Fallback intent: "${fallback}" for: "${userMessage}"`);
      return fallback;
    }

    if (!this.isEnabled) {
      return Intent.UNKNOWN;
    }

    try {
      const prompt = intentDetectionPrompt(userMessage, state, language);
      const result = await this.model.generateContent(prompt);
      const response = result.response.text().trim().toUpperCase();

      this.logger.log(`Gemini intent: "${response}" for: "${userMessage}"`);

      if (Object.values(Intent).includes(response as Intent)) {
        return response as Intent;
      }

      this.logger.warn(
        `Gemini returned unknown intent: "${response}" — using UNKNOWN`,
      );
      return Intent.UNKNOWN;
    } catch (error: any) {
      this.logger.error('Gemini intent detection failed', error.message);
      return Intent.UNKNOWN;
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
    } catch (error: any) {
      this.logger.error('Gemini language detection failed', error.message);
      return 'UNKNOWN';
    }
  }

  /**
   * Uses Gemini to semantically match a user's free-text question to the FAQ list.
   * Returns the FAQ id string if a good match is found, null otherwise.
   */
  async matchFaq(
    userMessage: string,
    faqs: { id: string; question: string }[],
    language: string,
  ): Promise<string | null> {
    if (!this.isEnabled || faqs.length === 0) return null;

    try {
      const list = faqs.map((f, i) => `${i + 1}. [${f.id}] ${f.question}`).join('\n');
      const prompt = `The user asked: "${userMessage}"\n\nAvailable FAQs:\n${list}\n\nWhich FAQ id best answers the user's question? Reply with ONLY the FAQ id string (e.g. "clx123abc"). If none match well, reply: NONE`;
      const result = await this.model.generateContent(prompt);
      const response = result.response.text().trim();
      if (response === 'NONE') return null;
      return response;
    } catch {
      return null;
    }
  }

  /**
   * Fast keyword fallback — handles the most common Moroccan French patterns
   * without burning Gemini quota. Returns UNKNOWN only when truly ambiguous.
   */
  private fallbackIntentDetection(message: string, state: string): Intent {
    const lower = message.toLowerCase().trim();

    // ── Numbered menu shortcuts (context-aware) ────────────────────────────
    if (lower === '1') {
      if (state === 'IDLE') return Intent.BOOK_APPOINTMENT;
      if (state === 'BOOKING_CONFIRM') return Intent.CONFIRM;
    }
    if (lower === '2') {
      if (state === 'IDLE') return Intent.ASK_FAQ;
      if (state === 'BOOKING_CONFIRM') return Intent.CANCEL;
    }
    if (lower === '3' && state === 'IDLE') return Intent.HUMAN_AGENT;

    // ── Confirm / Cancel ───────────────────────────────────────────────────
    if (
      /^(oui|yes|yep|confirm|confirmer|d'accord|ok|okay|c'est bon|exact|correct|✅|sure)$/i.test(
        lower,
      ) ||
      lower.includes('confirm_yes')
    ) {
      return Intent.CONFIRM;
    }

    if (
      /^(non|no|nope|cancel|annuler|quitter|stop|retour|menu|↩|exit)$/i.test(
        lower,
      ) ||
      lower.includes('confirm_no')
    ) {
      return Intent.CANCEL;
    }

    // ── Human agent ────────────────────────────────────────────────────────
    if (
      /(agent|humain|human|operator|opérateur|personne|parler à|speak to|talk to|someone|conseiller|👤)/i.test(
        lower,
      )
    ) {
      return Intent.HUMAN_AGENT;
    }

    // ── Book appointment — includes Moroccan French abbreviations ──────────
    if (
      /\b(rdv|r\.d\.v|rndv|rendez-vous|rendezvous|appointment|réserver|reserver|booking|consulter|consultation|médecin|medecin|docteur|doctor|prendre|schedule|موعد)\b/i.test(
        lower,
      )
    ) {
      return Intent.BOOK_APPOINTMENT;
    }

    // ── FAQ ────────────────────────────────────────────────────────────────
    if (
      /(horaire|heure|adresse|prix|tarif|coût|cout|où|ou est|quand|ouvert|fermé|ferme|time|open|close|location|téléphone|telephone|contact|faq)/i.test(
        lower,
      )
    ) {
      return Intent.ASK_FAQ;
    }

    // ── Greeting — only if message is purely a greeting ────────────────────
    if (/^(bonjour|bonsoir|salam|salut|hello|hi|hey|bonne journée|ahlan)[\s!,.]*$/i.test(lower)) {
      return Intent.GREETING;
    }

    return Intent.UNKNOWN;
  }
}