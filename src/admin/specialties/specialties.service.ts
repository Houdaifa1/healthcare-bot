import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Specialty, Language } from '@prisma/client';
import { CreateSpecialtyDto } from './dto/create-specialty.dto';
import { UpdateSpecialtyDto } from './dto/update-specialty.dto';
import { WhatsAppService } from 'src/whatsapp/whatsapp.service';

@Injectable()
export class SpecialtiesService {
  private readonly logger = new Logger(SpecialtiesService.name);

  constructor(
    private prisma: PrismaService,
    private whatsapp: WhatsAppService,
  ) {}

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
   * This prevents orphan doctors from being used for bookings.
   */
  async deactivate(id: string, clinicId: string): Promise<Specialty> {
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

  // ─── DELETE (hard-delete) ─────────────────────────────────────────────────

  /**
   * Step 1 — Initiates permanent deletion.
   *
   * Checks for future PENDING/CONFIRMED appointments tied to this specialty.
   * - None found → deletes immediately.
   * - Found      → returns the list for admin review without touching anything.
   *
   * On deletion:
   *   1. specialtyId nulled + specialtyName preserved on ALL appointments
   *   2. Future appointments cancelled (by exact snapshotted IDs)
   *   3. Time slots deleted for all affected doctors
   *   4. Doctors deactivated + specialtyId nulled
   *      (they can't reactivate until assigned a new active specialty — already enforced)
   *   5. Specialty deleted
   */
  async remove(id: string, clinicId: string): Promise<any> {
    const specialty = await this.prisma.specialty.findFirst({
      where: { id, clinicId },
    });

    if (!specialty) {
      throw new NotFoundException('Specialty not found in this clinic');
    }

    const specialtyName = this._resolveSpecialtyName(specialty.labels);
    const now = new Date();

    const futureAppointments = await this.prisma.appointment.findMany({
      where: {
        specialtyId: id,
        appointmentDate: { gte: now },
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
      orderBy: { appointmentDate: 'asc' },
    });

    if (futureAppointments.length === 0) {
      await this._hardDeleteSpecialty(id, specialtyName, clinicId, []);
      return { deleted: true, hadFutureAppointments: false };
    }

    return {
      requiresConfirmation: true,
      action: 'delete',
      specialtyId: id,
      specialtyName,
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
   * Step 2 — Confirms permanent deletion after admin reviews the list.
   *
   * Snapshots exact future appointment IDs BEFORE the transaction so
   * notifications go only to those patients — never to pre-existing
   * cancelled appointments and not matched by non-unique specialtyName.
   */
  async confirmDelete(
    id: string,
    clinicId: string,
    notify: boolean,
    customMessage?: string,
  ): Promise<any> {
    const specialty = await this.prisma.specialty.findFirst({
      where: { id, clinicId },
    });

    if (!specialty) {
      throw new NotFoundException('Specialty not found in this clinic');
    }

    const specialtyName = this._resolveSpecialtyName(specialty.labels);
    const now = new Date();

    // Snapshot BEFORE the transaction touches anything
    const appointmentsToCancel = await this.prisma.appointment.findMany({
      where: {
        specialtyId: id,
        appointmentDate: { gte: now },
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
      select: {
        id: true,
        patientName: true,
        patientPhone: true,
        appointmentDate: true,
        appointmentTime: true,
      },
    });

    await this._hardDeleteSpecialty(
      id,
      specialtyName,
      clinicId,
      appointmentsToCancel.map((a) => a.id),
    );

    // Notify only the snapshotted patients
    let notifiedCount = 0;
    const notificationErrors: string[] = [];

    if (notify && appointmentsToCancel.length > 0) {
      for (const apt of appointmentsToCancel) {
        try {
          const message = customMessage
            ? customMessage
                .replace(/\{patientName\}/g, apt.patientName)
                .replace(/\{specialtyName\}/g, specialtyName)
                .replace(
                  /\{appointmentDate\}/g,
                  apt.appointmentDate.toISOString().split('T')[0],
                )
                .replace(/\{appointmentTime\}/g, apt.appointmentTime)
            : `Cher patient, votre rendez-vous a été annulé suite à la suppression de la spécialité ${specialtyName}. Veuillez nous contacter pour reprogrammer. Merci de votre compréhension.`;

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
      cancelledAppointments: appointmentsToCancel.length,
      notified: notify,
      notifiedCount,
      notificationErrors:
        notificationErrors.length > 0 ? notificationErrors : undefined,
    };
  }

  // ─── Shared transaction ───────────────────────────────────────────────────

  private async _hardDeleteSpecialty(
    specialtyId: string,
    specialtyName: string,
    clinicId: string,
    appointmentIdsToCancel: string[],
  ): Promise<void> {
    // Fetch affected doctor IDs BEFORE the transaction — once we null their
    // specialtyId inside the tx we can no longer find them by it
    const affectedDoctors = await this.prisma.doctor.findMany({
      where: { specialtyId, clinicId },
      select: { id: true },
    });
    const doctorIds = affectedDoctors.map((d) => d.id);

    await this.prisma.$transaction(async (tx) => {
      // 1. Null specialtyId on ALL appointments + preserve name for history
      await tx.appointment.updateMany({
        where: { specialtyId },
        data: {
          specialtyId: null,
          specialtyName, // same pattern as doctorName
        },
      });

      // 2. Cancel only the snapshotted future appointments by exact IDs
      //    (specialtyId is already null now, so we must use the IDs)
      if (appointmentIdsToCancel.length > 0) {
        await tx.appointment.updateMany({
          where: { id: { in: appointmentIdsToCancel } },
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
      //    activate() and update() in doctors.service.ts already block
      //    reactivation until an active specialty is assigned
      if (doctorIds.length > 0) {
        await tx.doctor.updateMany({
          where: { id: { in: doctorIds } },
          data: { isActive: false, specialtyId: null },
        });
      }

      // 5. Delete the specialty — no FK violations remain
      await tx.specialty.delete({ where: { id: specialtyId } });
    });
  }

  // ─── Helper ──────────────────────────────────────────────────────────────

  /**
   * Extracts a human-readable name from the multilingual labels JSON.
   * Falls back FR → EN → first available value.
   */
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