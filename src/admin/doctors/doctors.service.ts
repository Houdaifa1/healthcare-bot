import {
  Injectable,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Doctor } from '@prisma/client';
import { CreateDoctorDto } from './dto/create-doctor.dto';
import { UpdateDoctorDto } from './dto/update-doctor.dto';
import { ClinicGuardService } from 'src/common/services/clinic-guard.service';
import { WhatsAppService } from 'src/whatsapp/whatsapp.service';

@Injectable()
export class DoctorsService {
  private readonly logger = new Logger(DoctorsService.name);

  constructor(
    private prisma: PrismaService,
    private clinicGuard: ClinicGuardService,
    private whatsapp: WhatsAppService,
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

  /**
   * Initiates deletion. Checks for future appointments first.
   * - No future appointments → disconnects FK, deletes slots & doctor immediately
   * - Has future appointments → returns list for admin to review
   *
   * Always nulls out doctorId on linked appointments before deleting to
   * avoid FK constraint violations regardless of schema migration state.
   */
  async remove(id: string, clinicId: string): Promise<any> {
    const doctor = await this.clinicGuard.validateDoctorBelongsToClinic(
      id,
      clinicId,
    );

    const now = new Date();

    const futureAppointments = await this.prisma.appointment.findMany({
      where: {
        doctorId: doctor.id,
        appointmentDate: { gte: now },
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
      orderBy: { appointmentDate: 'asc' },
    });

    // No future appointments → safe to delete immediately
    if (futureAppointments.length === 0) {
      await this.prisma.$transaction(async (tx) => {
        // Null out doctorId on all linked appointments to break FK
        await tx.appointment.updateMany({
          where: { doctorId: doctor.id },
          data: { doctorId: null as any, doctorName: doctor.name },
        });
        await tx.timeSlot.deleteMany({ where: { doctorId: doctor.id } });
        await tx.doctor.delete({ where: { id: doctor.id } });
      });

      return { deleted: true, hadFutureAppointments: false };
    }

    return {
      requiresConfirmation: true,
      doctorId: doctor.id,
      doctorName: doctor.name,
      futureAppointments: futureAppointments.map((a) => ({
        id: a.id,
        patientName: a.patientName,
        patientPhone: a.patientPhone,
        appointmentDate: a.appointmentDate,
        appointmentTime: a.appointmentTime,
        status: a.status,
      })),
      futureAppointmentsCount: futureAppointments.length,
    };
  }

  /**
   * Confirms deletion after admin review.
   * 1. Nulls out doctorId on all linked appointments (breaks FK)
   * 2. Cancels future appointments
   * 3. Deletes slots & doctor atomically
   * 4. Sends WhatsApp notifications if requested
   */
  async confirmDelete(
    id: string,
    clinicId: string,
    notify: boolean,
    customMessage?: string,
  ): Promise<any> {
    const doctor = await this.clinicGuard.validateDoctorBelongsToClinic(
      id,
      clinicId,
    );

    const now = new Date();

    // ── Atomic operation in transaction ────────────────────────────────────
    await this.prisma.$transaction(async (tx) => {
      // 1. Null out doctorId on ALL appointments to break FK constraint
      await tx.appointment.updateMany({
        where: { doctorId: doctor.id },
        data: { doctorId: null as any, doctorName: doctor.name },
      });

      // 2. Cancel future PENDING/CONFIRMED appointments
      const cancelled = await tx.appointment.updateMany({
        where: {
          doctorName: doctor.name,
          appointmentDate: { gte: now },
          status: { in: ['PENDING', 'CONFIRMED'] },
        },
        data: { status: 'CANCELLED' as any },
      });

      // 3. Delete time slots
      await tx.timeSlot.deleteMany({ where: { doctorId: doctor.id } });

      // 4. Delete doctor (FK is already nulled out)
      await tx.doctor.delete({ where: { id: doctor.id } });
    });

    // ── Send WhatsApp notifications after deletion succeeds ──────────
    let notifiedCount = 0;
    const notificationErrors: string[] = [];

    if (notify) {
      const cancelledAppointments = await this.prisma.appointment.findMany({
        where: {
          doctorName: doctor.name,
          status: 'CANCELLED',
          appointmentDate: { gte: now },
        },
      });

      for (const apt of cancelledAppointments) {
        try {
          const message = customMessage
            ? customMessage
                .replace(/\{patientName\}/g, apt.patientName)
                .replace(/\{doctorName\}/g, doctor.name)
                .replace(/\{appointmentDate\}/g, apt.appointmentDate.toISOString().split('T')[0])
                .replace(/\{appointmentTime\}/g, apt.appointmentTime)
            : `Cher patient, votre rendez-vous chez ${doctor.name} a été annulé. Veuillez nous contacter pour reprogrammer. Merci de votre compréhension.`;

          await this.whatsapp.sendText(apt.patientPhone, message);
          notifiedCount++;
        } catch (err: any) {
          this.logger.error(
            `Failed to notify ${apt.patientName} (${apt.patientPhone}): ${err.message}`,
          );
          notificationErrors.push(apt.patientName);
        }
      }
    }

    return {
      deleted: true,
      cancelledAppointments: true,
      notified: notify,
      notifiedCount,
      notificationErrors: notificationErrors.length > 0 ? notificationErrors : undefined,
    };
  }
}