import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Specialty, Language } from '@prisma/client';
import { CreateSpecialtyDto } from './dto/create-specialty.dto';
import { UpdateSpecialtyDto } from './dto/update-specialty.dto';

@Injectable()
export class SpecialtiesService {
  private readonly logger = new Logger(SpecialtiesService.name);

  constructor(private prisma: PrismaService) {}

  async create(
    clinicId: string,
    createSpecialtyDto: CreateSpecialtyDto,
  ): Promise<Specialty> {
    const { slug } = createSpecialtyDto;

    return this.prisma.specialty.upsert({
      where: {
        clinicId_slug: { clinicId, slug },
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

  async findAll(clinicId: string, language?: Language): Promise<Specialty[]> {
    return this.prisma.specialty.findMany({
      where: { clinicId },
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

  /**
   * Soft-delete (deactivate) a specialty.
   * Also deactivates all doctors that reference this specialty.
   */
  async remove(id: string): Promise<Specialty> {
    return this.prisma.$transaction(async (tx) => {
      const specialty = await tx.specialty.update({
        where: { id },
        data: { isActive: false },
      });

      await tx.doctor.updateMany({
        where: { specialtyId: id, isActive: true },
        data: { isActive: false },
      });

      return specialty;
    });
  }

  /**
   * Hard-delete a specialty permanently.
   *
   * 1. Null specialtyId + preserve specialtyName on ALL appointments
   * 2. Cancel any future PENDING/CONFIRMED appointments
   * 3. Delete time slots for affected doctors
   * 4. Deactivate doctors + null their specialtyId
   * 5. Delete the specialty
   */
  async hardRemove(id: string, clinicId: string): Promise<Specialty> {
    const specialty = await this.prisma.specialty.findFirst({
      where: { id, clinicId },
    });

    if (!specialty) {
      throw new Error('Specialty not found in this clinic');
    }

    const specialtyName = this._resolveSpecialtyName(specialty.labels);

    // Fetch affected doctor IDs before the transaction
    const affectedDoctors = await this.prisma.doctor.findMany({
      where: { specialtyId: id, clinicId },
      select: { id: true },
    });
    const doctorIds = affectedDoctors.map((d) => d.id);

    const now = new Date();

    // Snapshot future appointments to cancel
    const futureAppointmentIds = await this.prisma.appointment.findMany({
      where: {
        specialtyId: id,
        appointmentDate: { gte: now },
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
      select: { id: true },
    });
    const idsToCancel = futureAppointmentIds.map((a) => a.id);

    return this.prisma.$transaction(async (tx) => {
      // 1. Null specialtyId on ALL appointments + preserve name for history
      await tx.appointment.updateMany({
        where: { specialtyId: id },
        data: { specialtyId: null, specialtyName } as any,
      });

      // 2. Cancel future appointments by exact IDs
      if (idsToCancel.length > 0) {
        await tx.appointment.updateMany({
          where: { id: { in: idsToCancel } },
          data: { status: 'CANCELLED' as any },
        });
      }

      // 3. Delete time slots for affected doctors
      if (doctorIds.length > 0) {
        await tx.timeSlot.deleteMany({
          where: { doctorId: { in: doctorIds } },
        });
      }

      // 4. Deactivate doctors + null their specialtyId
      await tx.doctor.updateMany({
        where: { specialtyId: id },
        data: { isActive: false, specialtyId: null } as any,
      });

      // 5. Delete the specialty — no FK violations remain
      return tx.specialty.delete({ where: { id } });
    });
  }

  private _resolveSpecialtyName(labels: any): string {
    if (!labels || typeof labels !== 'object') return 'Unknown Specialty';
    return (
      labels['FR'] ??
      labels['EN'] ??
      Object.values(labels)[0] ??
      'Unknown Specialty'
    );
  }
}
