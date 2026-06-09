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
import { Language } from '@prisma/client';

@UseGuards(JwtAuthGuard)
@Controller('api/admin/v1/specialties')
export class SpecialtiesController {
  constructor(private readonly specialtiesService: SpecialtiesService) {}

  @Post()
  create(
    @Body() createSpecialtyDto: CreateSpecialtyDto,
    @Query('clinicId') clinicId: string,
  ) {
    return this.specialtiesService.create(clinicId, createSpecialtyDto);
  }

  @Get()
  findAll(
    @Query('clinicId') clinicId: string,
    @Query('language') language?: Language,
  ) {
    return this.specialtiesService.findAll(clinicId, language);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateSpecialtyDto: UpdateSpecialtyDto,
  ) {
    return this.specialtiesService.update(id, updateSpecialtyDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.specialtiesService.remove(id);
  }
}
