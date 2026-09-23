import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '@platform/database/prisma.service';
import {
  BookingRequest,
  BookingRequestStatus,
  AppointmentStatus,
  BookingSource,
} from '@prisma/client';
import { ConfirmBookingRequestDto } from './dto/confirm-booking-request.dto';
import { RejectBookingRequestDto } from './dto/reject-booking-request.dto';
import { WhatsAppService } from '@integrations/whatsapp/whatsapp.service';
import { ClinOpsService } from '@integrations/clinops/clinops.service';

@Injectable()
export class BookingRequestsService {
  private readonly logger = new Logger(BookingRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsappService: WhatsAppService,
    private readonly clinops: ClinOpsService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // FIND ALL — filtered by clinicId + optional campaignId / status
  // ═══════════════════════════════════════════════════════════════════════════

  async findAll(
    clinicId: string,
    filters: {
      campaignId?: string;
      status?: BookingRequestStatus;
    },
  ): Promise<any[]> {
    const where: Record<string, any> = { clinicId };

    if (filters.campaignId) {
      where.campaignPatient = { campaignId: filters.campaignId };
    }

    if (filters.status) {
      where.status = filters.status;
    }

    this.logger.log(
      `Finding booking requests for clinic ${clinicId} with filters: ${JSON.stringify(filters)}`,
    );

    const rows = await this.prisma.bookingRequest.findMany({
      where,
      include: {
        campaignPatient: {
          select: {
            id:              true,
            patientName:     true,
            phone:           true,
            campaignId:      true,
            visitDate:       true,
            prestation:      true,
            medecinTraitant: true,
          },
        },
        appointment: {
          select: {
            id:              true,
            appointmentDate: true,
            appointmentTime: true,
            doctorName:      true,
            specialtyName:   true,
            status:          true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((row) => this.withDisplayPatient(row));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FIND ONE — single booking request scoped to clinicId
  // ═══════════════════════════════════════════════════════════════════════════

  async findOne(clinicId: string, id: string): Promise<any> {
    const bookingRequest = await this.prisma.bookingRequest.findFirst({
      where: { id, clinicId },
      include: {
        campaignPatient: {
          select: {
            id:              true,
            patientName:     true,
            phone:           true,
            campaignId:      true,
            visitDate:       true,
            prestation:      true,
            medecinTraitant: true,
          },
        },
        appointment: true,
      },
    });

    if (!bookingRequest) {
      throw new NotFoundException(`Booking request ${id} not found`);
    }

    return this.withDisplayPatient(bookingRequest);
  }

  // Inbound requests have no CampaignPatient row (no campaign, no walk-in
  // record) — patient identity lives directly on the BookingRequest instead.
  // The dashboard's existing "Patient" column only ever read
  // `campaignPatient.patientName`, so for INBOUND rows we synthesize the same
  // shape from the row's own fields rather than requiring a frontend change.
  private withDisplayPatient(row: any): any {
    if (row.source === BookingSource.INBOUND && !row.campaignPatient) {
      return {
        ...row,
        campaignPatient: {
          id:              null,
          patientName:     row.patientName,
          phone:           row.patientPhone,
          campaignId:      null,
          visitDate:       null,
          prestation:      row.preferredSpecialty,
          medecinTraitant: row.preferredDoctor,
        },
      };
    }
    return row;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIRM — creates an Appointment record and links it
  // ═══════════════════════════════════════════════════════════════════════════

  async confirm(
    clinicId: string,
    id: string,
    dto: ConfirmBookingRequestDto,
  ): Promise<BookingRequest> {
    const bookingRequest = await this.findOneRaw(clinicId, id);

    if (bookingRequest.status !== BookingRequestStatus.PENDING) {
      throw new ConflictException(
        `Booking request is already ${bookingRequest.status}`,
      );
    }

    if (bookingRequest.appointmentId) {
      throw new ConflictException(
        'Booking request already has an associated appointment',
      );
    }
    if (bookingRequest.externalAttemptAt) {
      throw new ConflictException('A ClinOps booking attempt already exists. Check the clinic system before retrying.');
    }

    // CAMPAIGN requests carry patient identity via CampaignPatient; INBOUND
    // requests carry it directly on the BookingRequest itself (no CampaignPatient
    // row exists for a walk-in WhatsApp patient).
    let patientName: string;
    let patientPhone: string;
    let fallbackDoctorName: string | undefined;
    let fallbackSpecialtyName: string | undefined;
    let recordedPatientId: number | null = bookingRequest.clinopsPatientId;

    if (bookingRequest.source === BookingSource.INBOUND) {
      if (!bookingRequest.patientName || !bookingRequest.patientPhone) {
        throw new NotFoundException('Inbound booking request is missing patient identity');
      }
      patientName = bookingRequest.patientName;
      patientPhone = bookingRequest.patientPhone;
    } else {
      const campaignPatient = await this.prisma.campaignPatient.findUnique({
        where: { id: bookingRequest.campaignPatientId! },
      });

      if (!campaignPatient) {
        this.logger.error(
          `CampaignPatient ${bookingRequest.campaignPatientId} not found for booking request ${id}`,
        );
        throw new NotFoundException('Campaign patient not found');
      }
      patientName = campaignPatient.patientName;
      patientPhone = campaignPatient.phone;
      fallbackDoctorName = campaignPatient.medecinTraitant;
      fallbackSpecialtyName = campaignPatient.prestation;
      recordedPatientId = campaignPatient.clinopsPatientId;
    }

    // ── Resolve the appointment date/time ─────────────────────────────────
    // INBOUND requests already carry the exact slot the patient picked — staff
    // can confirm as-is without re-entering it, but may still override via dto.
    const appointmentDateInput = dto.appointmentDate ?? bookingRequest.requestedDate ?? undefined;
    const appointmentTimeInput = dto.appointmentTime ?? bookingRequest.requestedTime ?? undefined;

    if (!appointmentDateInput || !appointmentTimeInput) {
      throw new BadRequestException('appointmentDate and appointmentTime are required');
    }

    const date = appointmentDateInput.slice(0, 10);
    const appointmentDate = new Date(`${date}T00:00:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(appointmentDate.getTime()) ||
        appointmentDate.getFullYear() !== Number(date.slice(0, 4)) ||
        appointmentDate.getMonth() + 1 !== Number(date.slice(5, 7)) ||
        appointmentDate.getDate() !== Number(date.slice(8, 10))) {
      throw new BadRequestException('appointmentDate is not a valid date');
    }
    const datePrevue = `${date}T${appointmentTimeInput}:00`;
    const clinicNow = new Date().toLocaleString('sv-SE', { timeZone: 'Africa/Casablanca', hour12: false }).replace(' ', 'T');
    if (datePrevue <= clinicNow) {
      throw new BadRequestException('appointmentDate and appointmentTime must be in the future');
    }

    const doctorName = dto.doctorName ?? bookingRequest.preferredDoctor ?? fallbackDoctorName;
    if (!doctorName) throw new BadRequestException('doctorName is required');

    if (this.clinops.isLiveMode()) {
      if (!dto.patientId || !dto.specialityId || !dto.motif?.trim()) {
        throw new BadRequestException('Live ClinOps confirmation requires verified patientId, specialityId and motif');
      }
      if (recordedPatientId && recordedPatientId !== dto.patientId) {
        throw new BadRequestException('patientId differs from the patient identified for this request');
      }
      const normalizePhone = (value: string) => {
        const digits = value.replace(/\D/g, '');
        return /^0\d{9}$/.test(digits) ? `212${digits.slice(1)}` : digits;
      };
      const patients = await this.clinops.searchPatients({ numeroTelephone: patientPhone });
      if (!patients.some(patient => patient.patient_id === dto.patientId &&
          [patient.numeroTelephonePrincipale, patient.numeroTelephoneSecondaire]
            .some(number => number && normalizePhone(number) === normalizePhone(patientPhone)))) {
        throw new BadRequestException('patientId could not be verified against the patient phone in ClinOps');
      }
      const available = await this.clinops.getAvailableDoctorsByDate(
        dto.specialityId, date, appointmentTimeInput, id,
      );
      if (!available.some(d => d.doctorLabel.toLocaleLowerCase() === doctorName.toLocaleLowerCase())) {
        throw new ConflictException('Doctor is not available in ClinOps at this date and time');
      }
      const claimed = await this.prisma.bookingRequest.updateMany({
        where: { id, clinicId, status: BookingRequestStatus.PENDING, externalAttemptAt: null },
        data: { externalAttemptAt: new Date(), externalAttemptState: 'SUBMITTING' },
      });
      if (claimed.count !== 1) throw new ConflictException('Booking request changed while confirming');

      try {
        await this.clinops.createNewRDV({
          patientId: dto.patientId,
          datePrevue,
          motif: dto.motif.trim(),
          medecinTraitant: doctorName,
        });
      } catch (error) {
        await this.prisma.bookingRequest.update({
          where: { id }, data: { externalAttemptState: 'RECONCILE' },
        });
        throw error;
      }
    }

    // No local Doctor/Specialty table exists to resolve preferredDoctor
    // against — doctors and specialties only exist via ClinOps, and
    // BookingRequest doesn't carry a ClinOps doctor id (only the free-text
    // name the patient/AI captured). So doctorId/specialtyId on the created
    // Appointment stay null; doctorName/specialtyName (below) are the durable
    // record. A same-doctor-same-slot conflict check would need a real
    // ClinOps doctor id to compare against, which isn't available here.
    const doctorId: string | null = null;
    const specialtyId: string | null = null;

    // Create Appointment, preserving the ClinOps text fields (doctorName/
    // specialtyName) for the record.
    let updated: BookingRequest;
    try {
      updated = await this.prisma.$transaction(async tx => {
        const appointment = await tx.appointment.create({
          data: {
            clinicId,
            patientName,
            patientPhone,
            appointmentDate,
            appointmentTime: appointmentTimeInput,
            status: AppointmentStatus.CONFIRMED,
            doctorId,
            specialtyId,
            doctorName,
            specialtyName: bookingRequest.preferredSpecialty ?? fallbackSpecialtyName,
            notes: bookingRequest.reason ?? undefined,
            source: bookingRequest.source,
          },
        });
        const confirmation = {
          status: BookingRequestStatus.CONFIRMED,
          appointmentId: appointment.id,
          confirmedAt: new Date(),
          externalAttemptState: this.clinops.isLiveMode() ? 'CONFIRMED' : null,
        };
        if (this.clinops.isLiveMode()) {
          return tx.bookingRequest.update({ where: { id }, data: confirmation });
        }
        const claimed = await tx.bookingRequest.updateMany({
          where: { id, clinicId, status: BookingRequestStatus.PENDING, appointmentId: null },
          data: confirmation,
        });
        if (claimed.count !== 1) throw new ConflictException('Booking request changed while confirming');
        return tx.bookingRequest.findUniqueOrThrow({ where: { id } });
      });
    } catch (error) {
      if (this.clinops.isLiveMode()) {
        await this.prisma.bookingRequest.update({
          where: { id }, data: { externalAttemptState: 'RECONCILE' },
        }).catch(() => undefined);
      }
      throw error;
    }

    // Send WhatsApp notification if a message was provided
    if (dto.message?.trim()) {
      try {
        await this.whatsappService.sendText(patientPhone, dto.message.trim());
        this.logger.log(`Confirmation message sent to ${patientPhone}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to send confirmation message to ${patientPhone}: ${msg}`);
      }
    }

    return updated;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DELETE — hard delete a booking request
  // ═══════════════════════════════════════════════════════════════════════════

  async remove(clinicId: string, id: string): Promise<void> {
    const bookingRequest = await this.findOneRaw(clinicId, id);
    if (bookingRequest.status !== BookingRequestStatus.PENDING || bookingRequest.externalAttemptAt) {
      throw new ConflictException('A confirmed or attempted booking must be retained for reconciliation');
    }

    this.logger.log(
      `Deleting booking request ${id} for clinic ${clinicId}`,
    );

    const deleted = await this.prisma.bookingRequest.deleteMany({
      where: { id, clinicId, status: BookingRequestStatus.PENDING, externalAttemptAt: null },
    });
    if (deleted.count !== 1) throw new ConflictException('Booking request changed while deleting');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REJECT
  // ═══════════════════════════════════════════════════════════════════════════

  async reject(
    clinicId: string,
    id: string,
    dto?: RejectBookingRequestDto,
  ): Promise<BookingRequest> {
    const bookingRequest = await this.findOneRaw(clinicId, id);

    if (bookingRequest.status !== BookingRequestStatus.PENDING) {
      throw new ConflictException(
        `Booking request is already ${bookingRequest.status}`,
      );
    }
    if (bookingRequest.externalAttemptAt) {
      throw new ConflictException('Check the ClinOps booking attempt before rejecting this request');
    }

    const patientPhone = bookingRequest.source === BookingSource.INBOUND
      ? bookingRequest.patientPhone
      : (await this.prisma.campaignPatient.findUnique({
          where: { id: bookingRequest.campaignPatientId! },
        }))?.phone;

    this.logger.log(
      `Rejecting booking request ${id} for clinic ${clinicId}`,
    );

    const rejected = await this.prisma.bookingRequest.updateMany({
      where: { id, clinicId, status: BookingRequestStatus.PENDING, externalAttemptAt: null },
      data: { status: BookingRequestStatus.REJECTED },
    });
    if (rejected.count !== 1) throw new ConflictException('Booking request changed while rejecting');
    const updated = await this.prisma.bookingRequest.findUniqueOrThrow({ where: { id } });

    // Send WhatsApp notification if a message was provided and not silent
    if (dto?.message?.trim() && !dto?.silent && patientPhone) {
      try {
        await this.whatsappService.sendText(patientPhone, dto.message.trim());
        this.logger.log(`Rejection message sent to ${patientPhone}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to send rejection message to ${patientPhone}: ${msg}`);
      }
    }

    return updated;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  private async findOneRaw(
    clinicId: string,
    id: string,
  ): Promise<BookingRequest> {
    const bookingRequest = await this.prisma.bookingRequest.findFirst({
      where: { id, clinicId },
    });

    if (!bookingRequest) {
      throw new NotFoundException(`Booking request ${id} not found`);
    }

    return bookingRequest;
  }
}
