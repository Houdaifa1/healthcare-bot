import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
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
  ) {}

  async create(clinicId: string, dto: CreateDoctorDto): Promise<Doctor> {
    await this.clinicGuard.validateSpecialtyBelongsToClinic(
      dto.specialtyId,
      clinicId,
    );

    const specialty = await this.prisma.specialty.findUnique({
      where: { id: dto.specialtyId },
      select: { isActive: true },
    });
    if (!specialty || !specialty.isActive) {
      throw new BadRequestException(
        'Cannot create doctor: the selected specialty is inactive or does not exist.',
      );
    }

    return this.prisma.doctor.create({ data: { ...dto, clinicId } });
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
      orderBy: { displayOrder: 'asc' },
    });
  }

  async update(id: string, clinicId: string, dto: UpdateDoctorDto): Promise<Doctor> {
    const doctor = await this.clinicGuard.validateDoctorBelongsToClinic(
      id,
      clinicId,
    );

    if (dto.specialtyId) {
      await this.clinicGuard.validateSpecialtyBelongsToClinic(
        dto.specialtyId,
        clinicId,
      );
      const specialty = await this.prisma.specialty.findUnique({
        where: { id: dto.specialtyId },
        select: { isActive: true },
      });
      if (!specialty || !specialty.isActive) {
        throw new BadRequestException(
          'Cannot assign doctor to an inactive specialty.',
        );
      }
    }

    // Reactivation guard: specialty must be active before reactivating doctor
    if (dto.isActive === true) {
      const currentSpecialtyId = dto.specialtyId ?? doctor.specialtyId;
      const specialty = await this.prisma.specialty.findUnique({
        where: { id: currentSpecialtyId },
        select: { isActive: true },
      });
      if (!specialty || !specialty.isActive) {
        throw new BadRequestException(
          'Cannot reactivate this doctor: the associated specialty is inactive. Assign an active specialty first.',
        );
      }
    }

    return this.prisma.doctor.update({ where: { id: doctor.id }, data: dto });
  }

  // Soft-delete — ownership checked
  async remove(id: string, clinicId: string): Promise<Doctor> {
    const doctor = await this.clinicGuard.validateDoctorBelongsToClinic(
      id,
      clinicId,
    );
    return this.prisma.doctor.update({
      where: { id: doctor.id },
      data: { isActive: false },
    });
  }

  // Hard-delete — ownership checked, blocks if appointments exist
  async hardRemove(id: string, clinicId: string): Promise<Doctor> {
    const doctor = await this.clinicGuard.validateDoctorBelongsToClinic(
      id,
      clinicId,
    );

    const appointmentCount = await this.prisma.appointment.count({
      where: { doctorId: doctor.id },
    });
    if (appointmentCount > 0) {
      throw new BadRequestException(
        `Cannot permanently delete this doctor: ${appointmentCount} appointment(s) are linked to them. Deactivate instead.`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.timeSlot.deleteMany({ where: { doctorId: doctor.id } });
      return tx.doctor.delete({ where: { id: doctor.id } });
    });
  }
}