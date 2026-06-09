import { Injectable } from '@nestjs/common';
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
    key: MessageKey,
    language: Language,
    data: UpdateBotMessageDto,
  ): Promise<BotMessage> {
    return this.prisma.botMessage.update({
      where: {
        clinicId_key_language: {
          clinicId,
          key,
          language,
        },
      },
      data,
    });
  }
}
