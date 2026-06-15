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

  async findAll(
    clinicId: string,
    language?: Language,
  ): Promise<Specialty[]> {
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
   * This prevents orphan doctors from being used for bookings.
   */
  async remove(id: string): Promise<Specialty> {
    return this.prisma.$transaction(async (tx) => {
      const specialty = await tx.specialty.update({
        where: { id },
        data: { isActive: false },
      });

      // Deactivate all doctors using this specialty
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
   * Doctor.specialtyId has a hard FK to Specialty.id, so before the
   * specialty row can be deleted, every doctor referencing it must be
   * detached. We deactivate AND null out specialtyId on all doctors
   * under this specialty (active or not) — they cannot be reactivated
   * until the admin assigns them a new active specialty
   * (enforced in doctors.service.ts).
   */
  async hardRemove(id: string): Promise<Specialty> {
    return this.prisma.$transaction(async (tx) => {
      await tx.doctor.updateMany({
        where: { specialtyId: id },
        data: { isActive: false, specialtyId: null },
      });

      return tx.specialty.delete({ where: { id } });
    });
  }
}