import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
} from '@nestjs/common';
import { DoctorsService } from './doctors.service';
import { CreateDoctorDto } from './dto/create-doctor.dto';
import { UpdateDoctorDto } from './dto/update-doctor.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/types/auth-user.type';

@UseGuards(JwtAuthGuard)
@Controller('api/admin/v1/doctors')
export class DoctorsController {
  constructor(private readonly doctorsService: DoctorsService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateDoctorDto) {
    return this.doctorsService.create(user.clinicId, dto);
  }

  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.doctorsService.findAll(
      user.clinicId,
      query.specialtyId,
      query.isActive !== undefined ? query.isActive === 'true' : undefined,
    );
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateDoctorDto,
  ) {
    return this.doctorsService.update(id, user.clinicId, dto);
  }

  // ─── Activate (toggle isActive → true) ─────────────────────────────────

  @Patch(':id/activate')
  activate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.doctorsService.activate(id, user.clinicId);
  }

  // ─── Deactivate (soft-delete) ───────────────────────────────────────────

  @Delete(':id/deactivate')
  deactivate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.doctorsService.deactivate(id, user.clinicId);
  }

  @Delete(':id/deactivate/confirm')
  confirmDeactivate(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { notify: boolean; customMessage?: string },
  ) {
    return this.doctorsService.confirmDeactivate(
      id,
      user.clinicId,
      body.notify ?? false,
      body.customMessage,
    );
  }

  // ─── Delete (hard-delete) ───────────────────────────────────────────────

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.doctorsService.remove(id, user.clinicId);
  }

  @Delete(':id/confirm')
  confirmDelete(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { notify: boolean; customMessage?: string },
  ) {
    return this.doctorsService.confirmDelete(
      id,
      user.clinicId,
      body.notify ?? false,
      body.customMessage,
    );
  }
}