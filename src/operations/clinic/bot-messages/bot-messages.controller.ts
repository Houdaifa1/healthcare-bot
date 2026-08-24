import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { BotMessagesService } from './bot-messages.service';
import { UpdateBotMessageDto } from './dto/update-bot-message.dto';
import { JwtAuthGuard } from '@platform/auth/jwt-auth.guard';
import { Language, MessageKey } from '@prisma/client';

@UseGuards(JwtAuthGuard)
@Controller('api/admin/v1/clinic/:clinicId/messages')
export class BotMessagesController {
  constructor(private readonly botMessagesService: BotMessagesService) {}

  @Get()
  getMessages(
    @Param('clinicId') clinicId: string,
    @Query('language') language?: Language,
  ) {
    return this.botMessagesService.getMessages(clinicId, language);
  }

  @Patch(':key/:language')
  updateMessage(
    @Param('clinicId') clinicId: string,
    @Param('key') key: MessageKey,
    @Param('language') language: Language,
    @Body() updateBotMessageDto: UpdateBotMessageDto,
  ) {
    return this.botMessagesService.updateMessage(
      clinicId,
      key,
      language,
      updateBotMessageDto,
    );
  }
}
