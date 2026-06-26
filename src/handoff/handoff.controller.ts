import {
  Controller, Get, Post, Body, UseGuards, Logger, Req, Res,
} from '@nestjs/common';
import { HandoffService } from './handoff.service';
import { HandoffEventsService } from './handoff.events';
import { JwtAuthGuard } from '../admin/auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/types/auth-user.type';
import { IsString, IsNotEmpty, MinLength } from 'class-validator';
import type { Request, Response } from 'express';

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
    private readonly handoffEvents: HandoffEventsService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get('events')
  streamEvents(@Req() req: Request, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Send initial keepalive
    res.write('data: {"type":"connected"}\n\n');

    const subscription = this.handoffEvents.events$.subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    req.on('close', () => {
      subscription.unsubscribe();
      res.end();
    });
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  async getHandoffSessions(@CurrentUser() user: AuthUser) {
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