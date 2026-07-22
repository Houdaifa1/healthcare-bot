import { Injectable, BadRequestException, Logger } from '@nestjs/common';
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

  async update(
    id: string,
    clinicId: string,
    dto: UpdateDoctorDto,
  ): Promise<Doctor> {
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

      if (!currentSpecialtyId) {
        throw new BadRequestException(
          'Cannot reactivate this doctor: no specialty assigned. Assign a specialty first.',
        );
      }

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

  // ─── ACTIVATE (toggle isActive → true) ────────────────────────────────────

  /**
   * Activates a doctor and re-links any appointments that were orphaned
   * when this doctor was previously hard-deleted then recreated, OR when
   * the doctor's specialty was deleted (which nulls both doctorId and specialtyId
   * on appointments).
   *
   * Re-links appointments where:
   *   - doctorId IS NULL (orphaned by a previous hard-delete or specialty deletion)
   *   - doctorName matches this doctor's name
   *   - same clinicId
   *
   * Also restores specialtyId on those re-linked appointments if it was nulled
   * (happens when specialty was deleted — specialtyId is null on the appointment
   * but the doctor now has a valid active specialtyId again).
   *
   * Status of those appointments is intentionally NOT changed here — they were
   * CANCELLED when the doctor/specialty was deactivated/deleted. The admin can
   * manually update individual statuses from the Appointments page.
   */
  async activate(id: string, clinicId: string): Promise<Doctor> {
    const doctor = await this.clinicGuard.validateDoctorBelongsToClinic(
      id,
      clinicId,
    );

    if (doctor.isActive) {
      throw new BadRequestException('Doctor is already active.');
    }

    if (!doctor.specialtyId) {
      throw new BadRequestException(
        'Cannot activate this doctor: no specialty assigned. Assign a specialty first.',
      );
    }

    const specialty = await this.prisma.specialty.findUnique({
      where: { id: doctor.specialtyId },
      select: { isActive: true },
    });
    if (!specialty || !specialty.isActive) {
      throw new BadRequestException(
        'Cannot activate this doctor: the associated specialty is inactive. Assign an active specialty first.',
      );
    }

    const [updatedDoctor] = await this.prisma.$transaction([
      // 1. Activate the doctor
      this.prisma.doctor.update({
        where: { id: doctor.id },
        data: { isActive: true },
      }),
      // 2. Re-link orphaned appointments by name match and restore specialtyId.
      //
      //    Two scenarios land here:
      //    a) Doctor was hard-deleted then recreated → doctorId is null, specialtyId
      //       may or may not be null depending on whether specialty still exists.
      //    b) Doctor's specialty was deleted → doctorId is null (specialty deletion
      //       nulls it) AND specialtyId is null on the appointment.
      //
      //    In both cases we restore doctorId. We also restore specialtyId using the
      //    doctor's current (valid, active) specialtyId so the appointment is fully
      //    re-linked and no longer shows as orphaned on either FK.
      this.prisma.appointment.updateMany({
        where: {
          clinicId,
          doctorId: null,
          doctorName: doctor.name,
        },
        data: {
          doctorId: doctor.id,
          specialtyId: doctor.specialtyId, // restore if it was nulled by specialty deletion
        },
      }),
    ]);

    return updatedDoctor;
  }

  // ─── DEACTIVATE (soft-delete) ───────────────────────────────────────────

  /**
   * Initiates deactivation. Checks for future PENDING/CONFIRMED appointments.
   * - None found → deactivates immediately.
   * - Found       → returns list for admin review (notify or not).
   *
   * NOTE: deactivation does NOT null doctorId on appointments. The doctor
   * record still exists. Appointments keep their doctorId. The admin cannot
   * change status on appointments whose doctor is inactive — enforced on
   * the appointments service side.
   */
  async deactivate(id: string, clinicId: string): Promise<any> {
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

    if (futureAppointments.length === 0) {
      await this.prisma.doctor.update({
        where: { id: doctor.id },
        data: { isActive: false },
      });
      return { deactivated: true, hadFutureAppointments: false };
    }

    return {
      requiresConfirmation: true,
      action: 'deactivate',
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
   * Confirms deactivation after admin review.
   *
   * Snapshots the exact future appointment IDs BEFORE cancelling so
   * notifications go only to those patients — never to pre-existing
   * cancelled appointments.
   *
   * doctorId is NOT nulled on appointments. The appointments table keeps
   * the FK intact (doctor record still exists). Status-change on those
   * appointments is blocked by the appointments service (doctor inactive).
   */
  async confirmDeactivate(
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

    // Snapshot BEFORE touching anything
    const appointmentsToCancel = await this.prisma.appointment.findMany({
      where: {
        doctorId: doctor.id,
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

    // Cancel by exact IDs
    if (appointmentsToCancel.length > 0) {
      await this.prisma.appointment.updateMany({
        where: { id: { in: appointmentsToCancel.map((a) => a.id) } },
        data: { status: 'CANCELLED' as any },
      });
    }

    // Deactivate
    await this.prisma.doctor.update({
      where: { id: doctor.id },
      data: { isActive: false },
    });

    // Notify
    let notifiedCount = 0;
    const notificationErrors: string[] = [];

    if (notify && appointmentsToCancel.length > 0) {
      for (const apt of appointmentsToCancel) {
        try {
          const message = customMessage
            ? customMessage
                .replace(/\{patientName\}/g, apt.patientName)
                .replace(/\{doctorName\}/g, doctor.name)
                .replace(
                  /\{appointmentDate\}/g,
                  apt.appointmentDate.toISOString().split('T')[0],
                )
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
      deactivated: true,
      cancelledAppointments: appointmentsToCancel.length,
      notified: notify,
      notifiedCount,
      notificationErrors:
        notificationErrors.length > 0 ? notificationErrors : undefined,
    };
  }

  // ─── DELETE (hard-delete) ─────────────────────────────────────────────────

  /**
   * Initiates permanent deletion. Checks for future appointments first.
   * - None → deletes immediately (nulls doctorId on all appointments, preserves doctorName).
   * - Found → returns list for admin review.
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

    if (futureAppointments.length === 0) {
      await this.prisma.$transaction(async (tx) => {
        // Null FK, preserve name for history
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
      action: 'delete',
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
   * Confirms permanent deletion.
   *
   * Snapshots exact future appointment IDs BEFORE the transaction so
   * notifications are sent only to those patients — not to pre-existing
   * cancelled ones, and not matched by non-unique doctorName.
   *
   * After deletion doctorId is NULL on all appointments.
   * The appointments service blocks status changes when doctorId is null.
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

    // Snapshot BEFORE the transaction
    const appointmentsToCancel = await this.prisma.appointment.findMany({
      where: {
        doctorId: doctor.id,
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

    await this.prisma.$transaction(async (tx) => {
      // Null FK on all appointments (preserves history), save doctor name
      await tx.appointment.updateMany({
        where: { doctorId: doctor.id },
        data: { doctorId: null as any, doctorName: doctor.name },
      });

      // Cancel the exact future ones by ID (doctorId is now null, use IDs)
      if (appointmentsToCancel.length > 0) {
        await tx.appointment.updateMany({
          where: { id: { in: appointmentsToCancel.map((a) => a.id) } },
          data: { status: 'CANCELLED' as any },
        });
      }

      await tx.timeSlot.deleteMany({ where: { doctorId: doctor.id } });
      await tx.doctor.delete({ where: { id: doctor.id } });
    });

    // Notify only the snapshotted patients
    let notifiedCount = 0;
    const notificationErrors: string[] = [];

    if (notify && appointmentsToCancel.length > 0) {
      for (const apt of appointmentsToCancel) {
        try {
          const message = customMessage
            ? customMessage
                .replace(/\{patientName\}/g, apt.patientName)
                .replace(/\{doctorName\}/g, doctor.name)
                .replace(
                  /\{appointmentDate\}/g,
                  apt.appointmentDate.toISOString().split('T')[0],
                )
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
      cancelledAppointments: appointmentsToCancel.length,
      notified: notify,
      notifiedCount,
      notificationErrors:
        notificationErrors.length > 0 ? notificationErrors : undefined,
    };
  }
}
