import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Doctor } from '@prisma/client';
import { CreateDoctorDto } from './dto/create-doctor.dto';
import { UpdateDoctorDto } from './dto/update-doctor.dto';

@Injectable()
export class DoctorsService {
  constructor(private prisma: PrismaService) { }

  async create(clinicId: string, dto: CreateDoctorDto): Promise<Doctor> {
    if (!clinicId) {
      throw new Error('clinicId missing from auth token');
    }

    return this.prisma.doctor.create({
      data: {
        ...dto,
        clinicId,
      },
    });
  }

  async findAll(
    clinicId: string,
    specialtyId?: string,
    isActive?: boolean,
  ): Promise<Doctor[]> {
    return this.prisma.doctor.findMany({
      where: {
        clinicId,
        ...(specialtyId && { specialtyId }),
        ...(isActive !== undefined && { isActive }),
      },
    });
  }

  async update(id: string, dto: UpdateDoctorDto): Promise<Doctor> {
    if (dto.specialtyId === '') {
      throw new Error('specialtyId cannot be empty');
    }

    return this.prisma.doctor.update({
      where: { id },
      data: dto,
    });
  }

  async remove(id: string): Promise<Doctor> {
    return this.prisma.doctor.update({
      where: { id },
      data: { isActive: false },
    });
  }
}
