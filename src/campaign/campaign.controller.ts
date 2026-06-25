import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { CampaignService } from './campaign.service';
import { TakeoverService } from './takeover.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { JwtAuthGuard } from '../admin/auth/jwt-auth.guard';
import { IsString, MinLength, IsNotEmpty } from 'class-validator';

// ─── Takeover DTOs ────────────────────────────────────────────────────────────

class TakeoverDto {
  @IsString()
  @IsNotEmpty()
  phone: string;
}

class StaffMessageDto {
  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsString()
  @MinLength(1)
  message: string;
}

class ReleaseBotDto {
  @IsString()
  @IsNotEmpty()
  phone: string;
}

// ─── Controller ───────────────────────────────────────────────────────────────

@UseGuards(JwtAuthGuard)
@Controller('api/admin/v1/campaigns')
export class CampaignController {
  constructor(
    private readonly campaignService: CampaignService,
    private readonly takeoverService: TakeoverService,
  ) {}

  // ── Campaign CRUD ──────────────────────────────────────────────────────────

  // POST /api/admin/v1/campaigns
  @Post()
  create(@Request() req: any, @Body() dto: CreateCampaignDto) {
    return this.campaignService.create(req.user.clinicId, dto);
  }

  // GET /api/admin/v1/campaigns
  @Get()
  findAll(@Request() req: any) {
    return this.campaignService.findAll(req.user.clinicId);
  }

  // ── Static routes MUST come before :id to avoid shadowing ────────────────
  // NestJS matches top-to-bottom; 'handovers', 'takeover', etc. must be
  // declared before ':id' routes, or NestJS will try to match them as IDs.

  // GET /api/admin/v1/campaigns/handovers
  @Get('handovers')
  getHandovers(@Request() req: any) {
    return this.takeoverService.getActiveHandovers(req.user.clinicId);
  }

  // POST /api/admin/v1/campaigns/takeover
  @Post('takeover')
  @HttpCode(HttpStatus.OK)
  takeover(@Request() req: any, @Body() dto: TakeoverDto) {
    return this.takeoverService.takeOver(req.user.clinicId, dto.phone);
  }

  // POST /api/admin/v1/campaigns/staff-message
  @Post('staff-message')
  @HttpCode(HttpStatus.OK)
  sendStaffMessage(@Request() req: any, @Body() dto: StaffMessageDto) {
    return this.takeoverService.sendStaffMessage(
      req.user.clinicId,
      dto.phone,
      dto.message,
    );
  }

  // POST /api/admin/v1/campaigns/release-bot
  @Post('release-bot')
  @HttpCode(HttpStatus.OK)
  releaseBot(@Request() req: any, @Body() dto: ReleaseBotDto) {
    return this.takeoverService.releaseToBot(req.user.clinicId, dto.phone);
  }

  // ── Parameterised routes ───────────────────────────────────────────────────

  // GET /api/admin/v1/campaigns/:id
  @Get(':id')
  findOne(@Request() req: any, @Param('id') id: string) {
    return this.campaignService.findOne(req.user.clinicId, id);
  }

  // PATCH /api/admin/v1/campaigns/:id
  @Patch(':id')
  update(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateCampaignDto,
  ) {
    return this.campaignService.update(req.user.clinicId, id, dto);
  }

  // GET /api/admin/v1/campaigns/:id/preview
  @Get(':id/preview')
  preview(@Request() req: any, @Param('id') id: string) {
    return this.campaignService.preview(req.user.clinicId, id);
  }

  // POST /api/admin/v1/campaigns/:id/launch
  @Post(':id/launch')
  launch(@Request() req: any, @Param('id') id: string) {
    return this.campaignService.launch(req.user.clinicId, id);
  }

  // POST /api/admin/v1/campaigns/:id/pause
  @Post(':id/pause')
  pause(@Request() req: any, @Param('id') id: string) {
    return this.campaignService.pause(req.user.clinicId, id);
  }

  // POST /api/admin/v1/campaigns/:id/resume
  @Post(':id/resume')
  resume(@Request() req: any, @Param('id') id: string) {
    return this.campaignService.resume(req.user.clinicId, id);
  }

  // POST /api/admin/v1/campaigns/:id/stop
  @Post(':id/stop')
  stop(@Request() req: any, @Param('id') id: string) {
    return this.campaignService.stop(req.user.clinicId, id);
  }

  // POST /api/admin/v1/campaigns/:id/cancel-schedule
  @Post(':id/cancel-schedule')
  cancelSchedule(@Request() req: any, @Param('id') id: string) {
    return this.campaignService.cancelSchedule(req.user.clinicId, id);
  }

  // DELETE /api/admin/v1/campaigns/:id
  @Delete(':id')
  remove(@Request() req: any, @Param('id') id: string) {
    return this.campaignService.remove(req.user.clinicId, id);
  }
}