import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
} from '@nestjs/common';
import { SpecialtiesService } from './specialties.service';
import { CreateSpecialtyDto } from './dto/create-specialty.dto';
import { UpdateSpecialtyDto } from './dto/update-specialty.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/types/auth-user.type';

@UseGuards(JwtAuthGuard)
@Controller('api/admin/v1/specialties')
export class SpecialtiesController {
  constructor(private readonly specialtiesService: SpecialtiesService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateSpecialtyDto) {
    return this.specialtiesService.create(user.clinicId, dto);
  }

  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.specialtiesService.findAll(user.clinicId);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSpecialtyDto) {
    return this.specialtiesService.update(id, dto);
  }

  // Soft-delete (deactivate)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.specialtiesService.remove(id);
  }

  // Hard-delete (permanent) — must be defined BEFORE :id to avoid route conflict
  @Delete(':id/hard')
  hardRemove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.specialtiesService.hardRemove(id, user.clinicId);
  }
}
