import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { BotMessagesService } from './bot-messages.service';
import { UpdateBotMessageDto } from './dto/update-bot-message.dto';
import { JwtAuthGuard } from '@platform/auth/jwt-auth.guard';
import { Language, MessageKey } from '@prisma/client';
import { CurrentUser } from '@platform/shared/decorators/current-user.decorator';
import type { AuthUser } from '@platform/shared/types/auth-user.type';

@UseGuards(JwtAuthGuard)
@Controller('api/admin/v1/clinic/:clinicId/messages')
export class BotMessagesController {
  constructor(private readonly botMessagesService: BotMessagesService) {}

  @Get()
  getMessages(
    @CurrentUser() user: AuthUser,
    @Param('clinicId') clinicId: string,
    @Query('language') language?: Language,
  ) {
    if (clinicId !== user.clinicId) throw new ForbiddenException('Clinic access denied');
    return this.botMessagesService.getMessages(clinicId, language);
  }

  @Patch(':key/:language')
  updateMessage(
    @CurrentUser() user: AuthUser,
    @Param('clinicId') clinicId: string,
    @Param('key') key: MessageKey,
    @Param('language') language: Language,
    @Body() updateBotMessageDto: UpdateBotMessageDto,
  ) {
    if (clinicId !== user.clinicId) throw new ForbiddenException('Clinic access denied');
    return this.botMessagesService.updateMessage(
      clinicId,
      key,
      language,
      updateBotMessageDto,
    );
  }
}
