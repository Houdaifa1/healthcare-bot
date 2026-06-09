import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ClinicGuardService {
  constructor(private prisma: PrismaService) {}

  async validateSpecialtyBelongsToClinic(specialtyId: string, clinicId: string) {
    const specialty = await this.prisma.specialty.findFirst({
      where: { id: specialtyId, clinicId },
    });

    if (!specialty) {
      throw new NotFoundException('Specialty not found in this clinic');
    }

    return specialty;
  }

  async validateDoctorBelongsToClinic(doctorId: string, clinicId: string) {
    const doctor = await this.prisma.doctor.findFirst({
      where: { id: doctorId, clinicId },
    });

    if (!doctor) {
      throw new NotFoundException('Doctor not found in this clinic');
    }

    return doctor;
  }

  async validateDoctorSpecialtyMatch(doctorId: string, specialtyId: string, clinicId: string) {
    const doctor = await this.prisma.doctor.findFirst({
      where: { id: doctorId, clinicId, specialtyId },
    });

    if (!doctor) {
      throw new ForbiddenException('Doctor does not belong to this specialty');
    }

    return doctor;
  }
}