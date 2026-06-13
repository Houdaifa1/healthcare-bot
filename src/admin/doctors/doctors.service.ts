import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Doctor } from '@prisma/client';
import { CreateDoctorDto } from './dto/create-doctor.dto';
import { UpdateDoctorDto } from './dto/update-doctor.dto';
import { ClinicGuardService } from 'src/common/services/clinic-guard.service';

@Injectable()
export class DoctorsService {
  constructor(
    private prisma: PrismaService,
    private clinicGuard: ClinicGuardService,
  ) { }

  async create(clinicId: string, dto: CreateDoctorDto) {
    await this.clinicGuard.validateSpecialtyBelongsToClinic(dto.specialtyId, clinicId);

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

  async update(id: string, clinicId: string, dto: UpdateDoctorDto) {
  const doctor = await this.clinicGuard.validateDoctorBelongsToClinic(id, clinicId);

  if (dto.specialtyId) {
    await this.clinicGuard.validateSpecialtyBelongsToClinic(dto.specialtyId, clinicId);
  }

  return this.prisma.doctor.update({
    where: { id: doctor.id },
    data: dto,
  });
}

  async remove(id: string): Promise<Doctor> {
    return this.prisma.doctor.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async hardRemove(id: string): Promise<Doctor> {
    return this.prisma.$transaction(async (tx) => {
      // Delete associated records first to satisfy foreign key constraints
      await tx.timeSlot.deleteMany({ where: { doctorId: id } });
      await tx.appointment.deleteMany({ where: { doctorId: id } });
      return tx.doctor.delete({ where: { id } });
    });
  }
}
