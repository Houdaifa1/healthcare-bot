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
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { JwtAuthGuard } from '../admin/auth/jwt-auth.guard';

// ─── Controller ───────────────────────────────────────────────────────────────

@UseGuards(JwtAuthGuard)
@Controller('api/admin/v1/campaigns')
export class CampaignController {
  constructor(
    private readonly campaignService: CampaignService,
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

  // GET /api/admin/v1/campaigns/:id/patients/:patientId/conversation
  @Get(':id/patients/:patientId/conversation')
  getConversation(@Request() req: any, @Param('id') campaignId: string, @Param('patientId') patientId: string) {
    return this.campaignService.getConversation(req.user.clinicId, campaignId, patientId);
  }

  // POST /api/admin/v1/campaigns/:id/patients/:patientId/close
  @Post(':id/patients/:patientId/close')
  closePatientConversation(@Request() req: any, @Param('id') campaignId: string, @Param('patientId') patientId: string) {
    return this.campaignService.closePatientConversation(req.user.clinicId, campaignId, patientId);
  }

  // POST /api/admin/v1/campaigns/:id/patients/:patientId/take-over
  @Post(':id/patients/:patientId/take-over')
  takeOverConversation(@Request() req: any, @Param('id') campaignId: string, @Param('patientId') patientId: string) {
    return this.campaignService.takeOverConversation(req.user.clinicId, campaignId, patientId);
  }

  // POST /api/admin/v1/campaigns/:id/patients/:patientId/send-message
  @Post(':id/patients/:patientId/send-message')
  sendPatientMessage(@Request() req: any, @Param('id') campaignId: string, @Param('patientId') patientId: string, @Body('message') message: string) {
    return this.campaignService.sendPatientMessage(req.user.clinicId, campaignId, patientId, message);
  }

  // POST /api/admin/v1/campaigns/:id/patients/:patientId/resolve
  @Post(':id/patients/:patientId/resolve')
  resolveConversation(@Request() req: any, @Param('id') campaignId: string, @Param('patientId') patientId: string) {
    return this.campaignService.resolveConversation(req.user.clinicId, campaignId, patientId);
  }
}
