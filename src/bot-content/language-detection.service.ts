import { Injectable } from '@nestjs/common';
import { Language } from '@prisma/client';

@Injectable()
export class LanguageDetectionService {
  /**
   * Detects FR or EN from the first user message.
   * 1. Check for explicit language keywords.
   * 2. If ambiguous, return null.
   * 3. If clear, return Language.FR or Language.EN.
   * 4. Default fallback = clinic.defaultLanguage.
   */
  async detect(
    text: string,
    clinicDefaultLanguage: Language,
  ): Promise<Language | null> {
    const normalizedText = text.toLowerCase().trim();

    const frKeywords = ['français', 'francais', 'fr', 'bonjour'];
    const enKeywords = ['english', 'en', 'hello'];

    const isFrench = frKeywords.some((kw) => normalizedText.includes(kw));
    const isEnglish = enKeywords.some((kw) => normalizedText.includes(kw));

    if (isFrench && !isEnglish) {
      return Language.FR;
    }

    if (isEnglish && !isFrench) {
      return Language.EN;
    }

    if (!isFrench && !isEnglish) {
      // Could use AI fallback here, for now, use default
      return clinicDefaultLanguage;
    }

    // Ambiguous
    return null;
  }
}
