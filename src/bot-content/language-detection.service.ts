import { Injectable } from '@nestjs/common';
import { Language } from '@prisma/client';

@Injectable()
export class LanguageDetectionService {
  /**
   * Detects FR or EN from the first user message.
   *
   * FIX: The original code used .includes('en') which matched ANY French word
   * containing "en" (rendez-vous, prendre, bien, etc.) — causing French
   * patients to get EN language.
   *
   * New approach: match whole words only using word boundaries.
   */
  async detect(
    text: string,
    clinicDefaultLanguage: Language,
  ): Promise<Language | null> {
    const normalized = text.toLowerCase().trim();

    // Whole-word matches only — prevents 'en' inside 'rendez-vous', 'bien', etc.
    const frPatterns = [/\bfrançais\b/, /\bfrancais\b/, /\bbonjour\b/, /\bsalut\b/, /\bbonsoir\b/, /\boui\b/, /\bmerci\b/];
    const enPatterns = [/\benglish\b/, /\bhello\b/, /\bhi\b/, /\byes\b/, /\bthank\b/];

    // Explicit language selection buttons
    if (normalized === 'lang_fr' || normalized === '🇫🇷 français') return Language.FR;
    if (normalized === 'lang_en' || normalized === '🇬🇧 english') return Language.EN;

    const isFrench = frPatterns.some((re) => re.test(normalized));
    const isEnglish = enPatterns.some((re) => re.test(normalized));

    if (isFrench && !isEnglish) return Language.FR;
    if (isEnglish && !isFrench) return Language.EN;

    // Ambiguous or undetected — use clinic default (don't return null for
    // common neutral inputs like "1", "rdv", etc. which should just use the default)
    return clinicDefaultLanguage;
  }
}