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
import { SpecialtiesService } from './specialties.service';
import { CreateSpecialtyDto } from './dto/create-specialty.dto';
import { UpdateSpecialtyDto } from './dto/update-specialty.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/types/auth-user.type';
import { Language } from '@prisma/client';

@UseGuards(JwtAuthGuard)
@Controller('api/admin/v1/specialties')
export class SpecialtiesController {
  constructor(private readonly specialtiesService: SpecialtiesService) {}

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body() createSpecialtyDto: CreateSpecialtyDto,
  ) {
    return this.specialtiesService.create(user.clinicId, createSpecialtyDto);
  }

  @Get()
  findAll(
    @CurrentUser() user: AuthUser,
    @Query('language') language?: Language,
  ) {
    return this.specialtiesService.findAll(user.clinicId, language);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateSpecialtyDto: UpdateSpecialtyDto,
  ) {
    return this.specialtiesService.update(id, updateSpecialtyDto);
  }

  @Delete(':id/confirm')
  confirmDelete(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { notify: boolean; customMessage?: string },
  ) {
    return this.specialtiesService.confirmDelete(
      id,
      user.clinicId,
      body.notify ?? false,
      body.customMessage,
    );
  }
  
}