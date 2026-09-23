import {
  Controller, Get, Post, Body, UseGuards, Logger,
} from '@nestjs/common';
import { HandoffService } from './handoff.service';
import { JwtAuthGuard } from '@platform/auth/jwt-auth.guard';
import { IsString, IsNotEmpty, MinLength } from 'class-validator';
import { CurrentUser } from '@platform/shared/decorators/current-user.decorator';
import type { AuthUser } from '@platform/shared/types/auth-user.type';

export class ResolveHandoffDto {
  @IsString()
  @IsNotEmpty()
  phone!: string;
}

export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  phone!: string;

  @IsString()
  @MinLength(1)
  message!: string;
}

@Controller('api/admin/v1/handoff')
export class HandoffController {
  private readonly logger = new Logger(HandoffController.name);

  constructor(
    private readonly handoffService: HandoffService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  async getHandoffSessions(@CurrentUser() user: AuthUser) {
    return this.handoffService.getHandoffSessions(user.clinicId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('send-message')
  async sendMessage(@CurrentUser() user: AuthUser, @Body() dto: SendMessageDto) {
    this.logger.log('Sending staff handoff message');
    await this.handoffService.sendMessage(user.clinicId, dto.phone, dto.message);
    return { message: 'Message sent successfully.' };
  }

  @UseGuards(JwtAuthGuard)
  @Post('resolve')
  async resolveHandoff(@CurrentUser() user: AuthUser, @Body() dto: ResolveHandoffDto) {
    this.logger.log('Resolving handoff');
    await this.handoffService.resolveHandoff(user.clinicId, dto.phone);
    return { message: 'Handoff resolved successfully.' };
  }
}
