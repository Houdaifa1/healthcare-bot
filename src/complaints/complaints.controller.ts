import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ComplaintsService } from './complaints.service';
import { UpdateComplaintStatusDto } from './dto/update-complaint-status.dto';
import { UpdateComplaintStaffNoteDto } from './dto/update-complaint-staff-note.dto';
import { JwtAuthGuard } from '../admin/auth/jwt-auth.guard';
import { ComplaintStatus } from '@prisma/client';

@UseGuards(JwtAuthGuard)
@Controller('api/admin/v1/complaints')
export class ComplaintsController {
  constructor(private readonly complaintsService: ComplaintsService) {}

  // GET /api/admin/v1/complaints
  @Get()
  findAll(
    @Request() req: any,
    @Query('campaignId') campaignId?: string,
    @Query('status')     status?: ComplaintStatus,
    @Query('severity')   severity?: string,
    @Query('type')       type?: string,
  ) {
    return this.complaintsService.findAll(req.user.clinicId, {
      campaignId,
      status,
      severity,
      type,
    });
  }

  // GET /api/admin/v1/complaints/:id
  @Get(':id')
  findOne(@Request() req: any, @Param('id') id: string) {
    return this.complaintsService.findOne(req.user.clinicId, id);
  }

  // PATCH /api/admin/v1/complaints/patient/:campaignPatientId/status
  //
  // Bulk "resolve all for this patient". MUST stay declared above
  // `@Patch(':id/status')` — Nest matches routes in declaration order, so the
  // literal segment `patient` would otherwise be swallowed by the `:id` param.
  @Patch('patient/:campaignPatientId/status')
  updateStatusForPatient(
    @Request() req: any,
    @Param('campaignPatientId') campaignPatientId: string,
    @Body() dto: UpdateComplaintStatusDto,
  ) {
    return this.complaintsService.updateStatusForPatient(
      req.user.clinicId,
      campaignPatientId,
      dto.status,
    );
  }

  // PATCH /api/admin/v1/complaints/:id/status
  @Patch(':id/status')
  updateStatus(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateComplaintStatusDto,
  ) {
    return this.complaintsService.updateStatus(req.user.clinicId, id, dto.status);
  }

  // PATCH /api/admin/v1/complaints/:id/staff-note
  @Patch(':id/staff-note')
  updateStaffNote(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateComplaintStaffNoteDto,
  ) {
    return this.complaintsService.updateStaffNote(req.user.clinicId, id, dto.staffNote);
  }
}