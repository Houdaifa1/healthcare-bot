import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BotMessage, Language, MessageKey } from '@prisma/client';
import { UpdateBotMessageDto } from './dto/update-bot-message.dto';

@Injectable()
export class BotMessagesService {
  constructor(private prisma: PrismaService) {}

  async getMessages(
    clinicId: string,
    language?: Language,
  ): Promise<BotMessage[]> {
    return this.prisma.botMessage.findMany({
      where: {
        clinicId,
        ...(language && { language }),
      },
    });
  }

  /**
   * Upsert a message — creates if not exists, updates if exists.
   * This allows the admin dashboard to add new keys dynamically.
   */
  async updateMessage(
    clinicId: string,
    key: string,
    language: Language,
    data: UpdateBotMessageDto,
  ): Promise<BotMessage> {
    if (!Object.values(MessageKey).includes(key)) {
      throw new BadRequestException(
        `Invalid message key "${key}". Valid keys: ${Object.values(MessageKey).join(', ')}`,
      );
    }

    return this.prisma.botMessage.upsert({
      where: {
        clinicId_key_language: {
          clinicId,
          key: key as MessageKey,
          language,
        },
      },
      update: { body: data.body },
      create: {
        clinicId,
        key: key as MessageKey,
        language,
        body: data.body,
      },
    });
  }
}
