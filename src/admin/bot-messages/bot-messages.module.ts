import { Module } from '@nestjs/common';
import { BotMessagesService } from './bot-messages.service';
import { BotMessagesController } from './bot-messages.controller';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [BotMessagesService],
  controllers: [BotMessagesController],
})
export class BotMessagesModule {}