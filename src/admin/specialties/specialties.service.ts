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
    const { slug, language } = createSpecialtyDto;

    return this.prisma.specialty.upsert({
      where: {
        clinicId_slug_language: { clinicId, slug, language },
      },
      update: {
        ...createSpecialtyDto,
        isActive: createSpecialtyDto.isActive ?? true,
      },
      create: {
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
      orderBy: { displayOrder: 'asc' },
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

  async hardRemove(id: string): Promise<Specialty> {
    return this.prisma.$transaction(async (tx) => {
      // Delete associated records first to satisfy foreign key constraints
      const doctors = await tx.doctor.findMany({ where: { specialtyId: id }, select: { id: true } });
      const doctorIds = doctors.map((d) => d.id);

      if (doctorIds.length > 0) {
        await tx.timeSlot.deleteMany({ where: { doctorId: { in: doctorIds } } });
        await tx.appointment.deleteMany({ where: { doctorId: { in: doctorIds } } });
        await tx.doctor.deleteMany({ where: { specialtyId: id } });
      }

      return tx.specialty.delete({ where: { id } });
    });
  }
}