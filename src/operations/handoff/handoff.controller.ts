import {
  Controller, Get, Post, Body, UseGuards, Logger,
} from '@nestjs/common';
import { HandoffService } from './handoff.service';
import { JwtAuthGuard } from '@platform/auth/jwt-auth.guard';
import { IsString, IsNotEmpty, MinLength } from 'class-validator';

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
  async getHandoffSessions() {
    return this.handoffService.getHandoffSessions();
  }

  @UseGuards(JwtAuthGuard)
  @Post('send-message')
  async sendMessage(@Body() dto: SendMessageDto) {
    this.logger.log(`Sending staff message to ${dto.phone}`);
    await this.handoffService.sendMessage(dto.phone, dto.message);
    return { message: 'Message sent successfully.' };
  }

  @UseGuards(JwtAuthGuard)
  @Post('resolve')
  async resolveHandoff(@Body() dto: ResolveHandoffDto) {
    this.logger.log(`Resolving handoff for: ${dto.phone}`);
    await this.handoffService.resolveHandoff(dto.phone);
    return { message: 'Handoff resolved successfully.' };
  }
}