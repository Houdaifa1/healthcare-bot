import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Language, MessageKey } from '@prisma/client';

@Injectable()
export class BotMessageService {
  private readonly logger = new Logger(BotMessageService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Fetch a message template from DB and resolve {{variables}}.
   *
   * Production-grade fallback chain:
   *   1. Requested language
   *   2. EN (guaranteed by seed — always the most complete locale)
   *   3. NotFoundException (admin must add the missing key)
   *
   * Handlers MUST catch NotFoundException and use the FALLBACK key instead.
   * This ensures the conversation never hardcodes a string and never crashes.
   */
  async get(
    clinicId: string,
    key: MessageKey,
    vars?: Record<string, string>,
    language: Language = Language.FR,
  ): Promise<string> {
    // 1. Try the requested language
    const msg = await this.tryFetch(clinicId, key, language);

    if (msg) {
      return this.resolveVars(msg.body, vars);
    }

    // 2. Fallback to EN (always seeded, most complete)
    if (language !== Language.EN) {
      const enMsg = await this.tryFetch(clinicId, key, Language.EN);

      if (enMsg) {
        this.logger.warn(
          `BotMessage "${key}" missing for clinic ${clinicId} [${language}] — fell back to EN`,
        );
        return this.resolveVars(enMsg.body, vars);
      }
    }

    // 3. Nowhere to fall back — admin MUST seed this key
    this.logger.error(
      `BotMessage "${key}" not found for clinic ${clinicId} in ANY language. ` +
        `Seed files must include this key for both FR and EN.`,
    );

    throw new NotFoundException(
      `BotMessage key "${key}" not found for clinic ${clinicId} in [${language}] or [EN]. ` +
        `Run seed or add via admin dashboard.`,
    );
  }

  /**
   * Same as get() but returns null instead of throwing.
   * Use sparingly — prefer get() with proper error handling upstream.
   */
  async getOrNull(
    clinicId: string,
    key: MessageKey,
    language: Language = Language.FR,
  ): Promise<string | null> {
    try {
      return await this.get(clinicId, key, undefined, language);
    } catch {
      return null;
    }
  }

  /**
   * Safe version of get() — never throws.
   * Handlers should use this for every BotMessage call to prevent crashes.
   * If the key is missing from DB, it logs an error and returns the fallback text.
   */
  async getSafe(
    clinicId: string,
    key: MessageKey,
    vars?: Record<string, string>,
    language: Language = Language.FR,
    fallbackText = 'Sorry, something went wrong. Please try again.',
  ): Promise<string> {
    try {
      return await this.get(clinicId, key, vars, language);
    } catch {
      this.logger.error(
        `getSafe: key "${key}" missing for clinic ${clinicId} — using hardcoded fallback`,
      );
      return fallbackText;
    }
  }

  /**
   * Attempts to fetch a BotMessage from DB. Returns null if not found.
   */
  private async tryFetch(
    clinicId: string,
    key: MessageKey,
    language: Language,
  ): Promise<{ body: string } | null> {
    try {
      return await this.prisma.botMessage.findUnique({
        where: { clinicId_key_language: { clinicId, key, language } },
        select: { body: true },
      });
    } catch {
      return null;
    }
  }

  /**
   * Replaces {{variable}} placeholders in the body string.
   * Missing variables are left as-is so they're visible to the admin.
   */
  private resolveVars(body: string, vars?: Record<string, string>): string {
    if (!vars) return body;
    let resolved = body;
    for (const [k, v] of Object.entries(vars)) {
      resolved = resolved.replaceAll(`{{${k}}}`, v);
    }
    return resolved;
  }
}
