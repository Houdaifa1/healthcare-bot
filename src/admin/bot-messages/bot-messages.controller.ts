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
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Language } from '@prisma/client';
type MessageKey = 'WELCOME' | 'LANGUAGE_PROMPT' | 'ASK_NAME' | 'SELECT_SPECIALTY' | 'SELECT_DOCTOR' | 'SELECT_DATE' | 'SELECT_TIME' | 'CONFIRM_BOOKING' | 'BOOKING_SUCCESS' | 'BOOKING_CANCELLED' | 'FAQ_INTRO' | 'FAQ_NOT_FOUND' | 'FALLBACK' | 'HANDOFF_TRIGGERED' | 'SESSION_EXPIRED' | 'NO_SLOTS_AVAILABLE' | 'OUTSIDE_HOURS';

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
