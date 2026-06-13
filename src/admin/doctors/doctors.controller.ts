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
    query.isActive ? query.isActive === 'true' : undefined,
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

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.doctorsService.remove(id);
  }

  @Delete(':id/hard')
  hardRemove(@Param('id') id: string) {
    return this.doctorsService.hardRemove(id);
  }
}