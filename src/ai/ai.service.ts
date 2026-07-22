import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Groq from 'groq-sdk';
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
  private client!: Groq;
  private isEnabled = false;

  // Best free model on Groq: fast, smart, huge context
  private readonly MODEL = 'llama-3.3-70b-versatile';

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('GROQ_API_KEY');
    if (apiKey) {
      this.client = new Groq({ apiKey });
      this.isEnabled = true;
      this.logger.log('Groq AI initialized successfully');
    } else {
      this.logger.warn('GROQ_API_KEY not set — using keyword fallback only');
    }
  }

  async detectIntent(
    userMessage: string,
    state: string,
    language: string,
  ): Promise<Intent> {
    // Always run fallback first — handles unambiguous cases instantly
    // and saves Groq quota for truly ambiguous messages
    const fallback = this.fallbackIntentDetection(userMessage, state);
    if (fallback !== Intent.UNKNOWN) {
      this.logger.log(`Fallback intent: "${fallback}" for: "${userMessage}"`);
      return fallback;
    }

    if (!this.isEnabled) return Intent.UNKNOWN;

    try {
      const prompt = intentDetectionPrompt(userMessage, state, language);
      const completion = await this.client.chat.completions.create({
        model: this.MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 10, // intent is a single word — no need for more
        temperature: 0, // deterministic — we want consistent classification
      });

      const response =
        completion.choices[0]?.message?.content?.trim().toUpperCase() ?? '';
      this.logger.log(`Groq intent: "${response}" for: "${userMessage}"`);

      if (Object.values(Intent).includes(response as Intent)) {
        return response as Intent;
      }

      this.logger.warn(
        `Groq returned unknown intent: "${response}" — using UNKNOWN`,
      );
      return Intent.UNKNOWN;
    } catch (error: any) {
      this.logger.error('Groq intent detection failed', error.message);
      return Intent.UNKNOWN;
    }
  }

  async detectLanguage(userMessage: string): Promise<'FR' | 'EN' | 'UNKNOWN'> {
    if (!this.isEnabled) return 'UNKNOWN';

    try {
      const prompt = languageDetectionPrompt(userMessage);
      const completion = await this.client.chat.completions.create({
        model: this.MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 10,
        temperature: 0,
      });

      const response =
        completion.choices[0]?.message?.content?.trim().toUpperCase() ?? '';
      this.logger.log(`Groq language: "${response}" for: "${userMessage}"`);

      if (response === 'FR' || response === 'EN') return response;
      return 'UNKNOWN';
    } catch (error: any) {
      this.logger.error('Groq language detection failed', error.message);
      return 'UNKNOWN';
    }
  }

  async matchFaq(
    userMessage: string,
    faqs: { id: string; question: string }[],
    language: string,
  ): Promise<string | null> {
    if (!this.isEnabled || faqs.length === 0) return null;

    try {
      const list = faqs
        .map((f, i) => `${i + 1}. [${f.id}] ${f.question}`)
        .join('\n');
      const prompt = `The user asked: "${userMessage}"\n\nAvailable FAQs:\n${list}\n\nWhich FAQ id best answers the user's question? Reply with ONLY the FAQ id string (e.g. "clx123abc"). If none match well, reply: NONE`;

      const completion = await this.client.chat.completions.create({
        model: this.MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 50,
        temperature: 0,
      });

      const response = completion.choices[0]?.message?.content?.trim() ?? '';
      if (response === 'NONE' || !response) return null;
      return response;
    } catch {
      return null;
    }
  }

  /**
   * Fast keyword fallback — handles the most common Moroccan French patterns
   * without burning Groq quota. Returns UNKNOWN only when truly ambiguous.
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

    // ── Book appointment ───────────────────────────────────────────────────
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

    // ── Greeting ───────────────────────────────────────────────────────────
    if (
      /^(bonjour|bonsoir|salam|salut|hello|hi|hey|bonne journée|ahlan)[\s!,.]*$/i.test(
        lower,
      )
    ) {
      return Intent.GREETING;
    }

    return Intent.UNKNOWN;
  }
}
