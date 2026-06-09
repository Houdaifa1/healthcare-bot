import { Controller, Post, Body, UseGuards, Logger } from '@nestjs/common';
import { HandoffService } from './handoff.service';
import { JwtAuthGuard } from '../admin/auth/jwt-auth.guard';
import { IsString, IsNotEmpty } from 'class-validator';

export class ResolveHandoffDto {
  @IsString()
  @IsNotEmpty()
  phone: string;
}

@Controller('api/admin/v1/handoff')
export class HandoffController {
  private readonly logger = new Logger(HandoffController.name);

  constructor(private readonly handoffService: HandoffService) {}

  @UseGuards(JwtAuthGuard)
  @Post('resolve')
  async resolveHandoff(@Body() dto: ResolveHandoffDto) {
    this.logger.log(`Resolving handoff for: ${dto.phone}`);
    await this.handoffService.resolveHandoff(dto.phone);
    return { message: 'Handoff resolved successfully.' };
  }
}