import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Language, MessageKey } from '@prisma/client';

@Injectable()
export class BotMessageService {
  constructor(private prisma: PrismaService) {}

  /**
   * Fetch a message template from DB and resolve {{variables}}
   * NEVER returns a hardcoded string. Throws if key missing.
   */
  async get(
    clinicId: string,
    key: MessageKey,
    vars?: Record<string, string>,
    language: Language = Language.FR,
  ): Promise<string> {
    const msg = await this.prisma.botMessage.findUnique({
      where: { clinicId_key_language: { clinicId, key, language } },
    });

    if (!msg) {
      throw new NotFoundException(
        `BotMessage key "${key}" not found for clinic ${clinicId} [${language}]`,
      );
    }

    let body = msg.body;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        body = body.replaceAll(`{{${k}}}`, v);
      }
    }
    return body;
  }
}