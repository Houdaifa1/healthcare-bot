import { Controller, Get, Patch, Body, UseGuards } from '@nestjs/common';
import { ClinicService } from './clinic.service';
import { UpdateClinicDto } from './dto/update-clinic.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/types/auth-user.type';

@UseGuards(JwtAuthGuard)
@Controller('api/admin/v1/clinics')
export class ClinicController {
  constructor(private readonly clinicService: ClinicService) {}

  @Get()
  getClinic(@CurrentUser() user: AuthUser) {
    return this.clinicService.getClinic(user.clinicId);
  }

  @Patch()
  updateClinic(@CurrentUser() user: AuthUser, @Body() dto: UpdateClinicDto) {
    return this.clinicService.updateClinic(user.clinicId, dto);
  }
}
