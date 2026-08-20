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
  ): Promise<BookingRequest[]> {
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

    return this.prisma.bookingRequest.findMany({
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
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FIND ONE — single booking request scoped to clinicId
  // ═══════════════════════════════════════════════════════════════════════════

  async findOne(clinicId: string, id: string): Promise<BookingRequest> {
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

    return bookingRequest;
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

    // Load the campaign patient to get patient name and phone for the appointment
    const campaignPatient = await this.prisma.campaignPatient.findUnique({
      where: { id: bookingRequest.campaignPatientId },
    });

    if (!campaignPatient) {
      this.logger.error(
        `CampaignPatient ${bookingRequest.campaignPatientId} not found for booking request ${id}`,
      );
      throw new NotFoundException('Campaign patient not found');
    }

    // ── Validate the requested date/time ─────────────────────────────────
    const appointmentDate = new Date(dto.appointmentDate);
    if (Number.isNaN(appointmentDate.getTime())) {
      throw new BadRequestException('appointmentDate is not a valid date');
    }

    // A date that has already started cannot be booked.
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    if (appointmentDate < startOfToday) {
      throw new BadRequestException('appointmentDate cannot be in the past');
    }

    // ── Resolve doctor/specialty by name where possible ──────────────────
    // Campaign booking requests capture free-text doctor/specialty names (the AI
    // records what the patient said), so there is no guaranteed internal id. Try
    // to resolve to a real Doctor record to enable conflict checking and to link
    // the appointment back to the doctor for reporting.
    let doctorId: string | null = null;
    let specialtyId: string | null = null;

    if (bookingRequest.preferredDoctor) {
      const doctor = await this.prisma.doctor.findFirst({
        where: {
          clinicId,
          name: { equals: bookingRequest.preferredDoctor, mode: 'insensitive' },
        },
      });
      if (doctor) {
        doctorId = doctor.id;
        specialtyId = doctor.specialtyId;
      } else {
        this.logger.warn(
          `Could not resolve doctor "${bookingRequest.preferredDoctor}" to a Doctor record — creating appointment without doctorId`,
        );
      }
    }

    // ── Conflict check ───────────────────────────────────────────────────
    // Guard against double-booking the same doctor/time. This only fires when a
    // doctor could be resolved; otherwise staff review the dashboard anyway.
    if (doctorId) {
      const conflicting = await this.prisma.appointment.findFirst({
        where: {
          clinicId,
          doctorId,
          appointmentDate,
          appointmentTime: dto.appointmentTime,
          status: { in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED] },
        },
      });

      if (conflicting) {
        throw new ConflictException(
          `The selected slot (${dto.appointmentDate} ${dto.appointmentTime}) is already booked for this doctor`,
        );
      }
    }

    // Create Appointment with resolved ids where possible, preserving the
    // ClinOps text fields (doctorName/specialtyName) for the record.
    const appointment = await this.prisma.appointment.create({
      data: {
        clinicId,
        patientName:      campaignPatient.patientName,
        patientPhone:     campaignPatient.phone,
        appointmentDate,
        appointmentTime:  dto.appointmentTime,
        status:           AppointmentStatus.CONFIRMED,
        doctorId,
        specialtyId,
        doctorName:       bookingRequest.preferredDoctor  ?? campaignPatient.medecinTraitant,
        specialtyName:    bookingRequest.preferredSpecialty ?? campaignPatient.prestation,
        notes:            bookingRequest.reason ?? undefined,
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
        await this.whatsappService.sendText(campaignPatient.phone, dto.message.trim());
        this.logger.log(`Confirmation message sent to ${campaignPatient.phone}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to send confirmation message to ${campaignPatient.phone}: ${msg}`);
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

    const campaignPatient = await this.prisma.campaignPatient.findUnique({
      where: { id: bookingRequest.campaignPatientId },
    });

    this.logger.log(
      `Rejecting booking request ${id} for clinic ${clinicId}`,
    );

    const updated = await this.prisma.bookingRequest.update({
      where: { id },
      data:  { status: BookingRequestStatus.REJECTED },
    });

    // Send WhatsApp notification if a message was provided and not silent
    if (dto?.message?.trim() && !dto?.silent && campaignPatient?.phone) {
      try {
        await this.whatsappService.sendText(campaignPatient.phone, dto.message.trim());
        this.logger.log(`Rejection message sent to ${campaignPatient.phone}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to send rejection message to ${campaignPatient.phone}: ${msg}`);
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