import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  BookingRequest,
  BookingRequestStatus,
  AppointmentStatus,
  BookingSource,
} from '@prisma/client';
import { ConfirmBookingRequestDto } from './dto/confirm-booking-request.dto';
import { RejectBookingRequestDto } from './dto/reject-booking-request.dto';
import { WhatsAppService } from '../whatsapp/whatsapp.service';

@Injectable()
export class BookingRequestsService {
  private readonly logger = new Logger(BookingRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsappService: WhatsAppService,
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

    // CAMPAIGN requests carry patient identity via CampaignPatient; INBOUND
    // requests carry it directly on the BookingRequest itself (no CampaignPatient
    // row exists for a walk-in WhatsApp patient).
    let patientName: string;
    let patientPhone: string;
    let fallbackDoctorName: string | undefined;
    let fallbackSpecialtyName: string | undefined;

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
    }

    // ── Resolve the appointment date/time ─────────────────────────────────
    // INBOUND requests already carry the exact slot the patient picked — staff
    // can confirm as-is without re-entering it, but may still override via dto.
    const appointmentDateInput = dto.appointmentDate ?? bookingRequest.requestedDate ?? undefined;
    const appointmentTimeInput = dto.appointmentTime ?? bookingRequest.requestedTime ?? undefined;

    if (!appointmentDateInput || !appointmentTimeInput) {
      throw new BadRequestException('appointmentDate and appointmentTime are required');
    }

    const appointmentDate = new Date(appointmentDateInput);
    if (Number.isNaN(appointmentDate.getTime())) {
      throw new BadRequestException('appointmentDate is not a valid date');
    }

    // A date that has already started cannot be booked.
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    if (appointmentDate < startOfToday) {
      throw new BadRequestException('appointmentDate cannot be in the past');
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
    const appointment = await this.prisma.appointment.create({
      data: {
        clinicId,
        patientName,
        patientPhone,
        appointmentDate,
        appointmentTime:  appointmentTimeInput,
        status:           AppointmentStatus.CONFIRMED,
        doctorId,
        specialtyId,
        doctorName:       bookingRequest.preferredDoctor    ?? fallbackDoctorName,
        specialtyName:    bookingRequest.preferredSpecialty ?? fallbackSpecialtyName,
        notes:            bookingRequest.reason ?? undefined,
        source:           bookingRequest.source,
      },
    });

    this.logger.log(
      `Appointment ${appointment.id} created for booking request ${id}`,
    );

    // Link appointment to booking request and update status
    const updated = await this.prisma.bookingRequest.update({
      where: { id },
      data: {
        status:      BookingRequestStatus.CONFIRMED,
        appointmentId: appointment.id,
        confirmedAt: new Date(),
      },
    });

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

    this.logger.log(
      `Deleting booking request ${id} for clinic ${clinicId}`,
    );

    await this.prisma.bookingRequest.delete({
      where: { id },
    });
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

    const patientPhone = bookingRequest.source === BookingSource.INBOUND
      ? bookingRequest.patientPhone
      : (await this.prisma.campaignPatient.findUnique({
          where: { id: bookingRequest.campaignPatientId! },
        }))?.phone;

    this.logger.log(
      `Rejecting booking request ${id} for clinic ${clinicId}`,
    );

    const updated = await this.prisma.bookingRequest.update({
      where: { id },
      data:  { status: BookingRequestStatus.REJECTED },
    });

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