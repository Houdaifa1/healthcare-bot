import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Specialty, Language } from '@prisma/client';
import { CreateSpecialtyDto } from './dto/create-specialty.dto';
import { UpdateSpecialtyDto } from './dto/update-specialty.dto';

@Injectable()
export class SpecialtiesService {
  constructor(private prisma: PrismaService) {}

  async create(
    clinicId: string,
    createSpecialtyDto: CreateSpecialtyDto,
  ): Promise<Specialty> {
    return this.prisma.specialty.create({
      data: {
        ...createSpecialtyDto,
        clinicId,
      },
    });
  }

  async findAll(
    clinicId: string,
    language?: Language,
  ): Promise<Specialty[]> {
    return this.prisma.specialty.findMany({
      where: {
        clinicId,
        ...(language && { language }),
      },
    });
  }

  async update(
    id: string,
    updateSpecialtyDto: UpdateSpecialtyDto,
  ): Promise<Specialty> {
    return this.prisma.specialty.update({
      where: { id },
      data: updateSpecialtyDto,
    });
  }

  async remove(id: string): Promise<Specialty> {
    return this.prisma.specialty.update({
      where: { id },
      data: { isActive: false },
    });
  }
}
