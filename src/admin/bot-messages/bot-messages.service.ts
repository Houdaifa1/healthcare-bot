import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
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

  async updateMessage(
    clinicId: string,
    key: string,
    language: Language,
    data: UpdateBotMessageDto,
  ): Promise<BotMessage> {
    if (!Object.values(MessageKey).includes(key as MessageKey)) {
      throw new BadRequestException(
        `Invalid message key "${key}". Valid keys: ${Object.values(MessageKey).join(', ')}`,
      );
    }

    const message = await this.prisma.botMessage.findUnique({
      where: {
        clinicId_key_language: {
          clinicId,
          key: key as MessageKey,
          language,
        },
      },
    });

    if (!message) {
      throw new NotFoundException(
        `No message found for key "${key}" and language "${language}"`,
      );
    }

    return this.prisma.botMessage.update({
      where: {
        clinicId_key_language: {
          clinicId,
          key: key as MessageKey,
          language,
        },
      },
      data,
    });
  }
}