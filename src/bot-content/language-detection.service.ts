import { Injectable } from '@nestjs/common';
import { Language } from '@prisma/client';

@Injectable()
export class LanguageDetectionService {
  /**
   * Detects FR or EN from the first user message.
   *
   * Returns Language if confidently detected, null if truly ambiguous.
   * The caller (IdleHandler) will transition to LANGUAGE_SELECT when null
   * so the user can explicitly choose.
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

    // Both detected or neither detected — return null so the caller
    // (IdleHandler) can transition to LANGUAGE_SELECT.
    // Previously this returned clinicDefaultLanguage, which meant the
    // language selection flow was dead code that could never be reached.
    return null;
  }
}