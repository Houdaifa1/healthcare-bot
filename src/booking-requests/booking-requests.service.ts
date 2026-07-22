import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
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
            id: true,
            patientName: true,
            phone: true,
            campaignId: true,
            visitDate: true,
            prestation: true,
            medecinTraitant: true,
          },
        },
        appointment: {
          select: {
            id: true,
            appointmentDate: true,
            appointmentTime: true,
            doctorName: true,
            specialtyName: true,
            status: true,
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
            id: true,
            patientName: true,
            phone: true,
            campaignId: true,
            visitDate: true,
            prestation: true,
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

    // Create Appointment with ClinOps text fields (no internal doctorId/specialtyId)
    const appointment = await this.prisma.appointment.create({
      data: {
        clinicId,
        patientName: campaignPatient.patientName,
        patientPhone: campaignPatient.phone,
        appointmentDate: new Date(dto.appointmentDate),
        appointmentTime: dto.appointmentTime,
        status: AppointmentStatus.CONFIRMED,
        doctorName:
          bookingRequest.preferredDoctor ?? campaignPatient.medecinTraitant,
        specialtyName:
          bookingRequest.preferredSpecialty ?? campaignPatient.prestation,
        notes: bookingRequest.reason ?? undefined,
      },
    });

    this.logger.log(
      `Appointment ${appointment.id} created for booking request ${id}`,
    );

    // Link appointment to booking request and update status
    const updated = await this.prisma.bookingRequest.update({
      where: { id },
      data: {
        status: BookingRequestStatus.CONFIRMED,
        appointmentId: appointment.id,
        confirmedAt: new Date(),
      },
    });

    // Send WhatsApp notification if a message was provided
    if (dto.message?.trim()) {
      try {
        await this.whatsappService.sendText(
          campaignPatient.phone,
          dto.message.trim(),
        );
        this.logger.log(
          `Confirmation message sent to ${campaignPatient.phone}`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Failed to send confirmation message to ${campaignPatient.phone}: ${msg}`,
        );
      }
    }

    return updated;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DELETE — hard delete a booking request
  // ═══════════════════════════════════════════════════════════════════════════

  async remove(clinicId: string, id: string): Promise<void> {
    const bookingRequest = await this.findOneRaw(clinicId, id);

    this.logger.log(`Deleting booking request ${id} for clinic ${clinicId}`);

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

    this.logger.log(`Rejecting booking request ${id} for clinic ${clinicId}`);

    const updated = await this.prisma.bookingRequest.update({
      where: { id },
      data: { status: BookingRequestStatus.REJECTED },
    });

    // Send WhatsApp notification if a message was provided and not silent
    if (dto?.message?.trim() && !dto?.silent && campaignPatient?.phone) {
      try {
        await this.whatsappService.sendText(
          campaignPatient.phone,
          dto.message.trim(),
        );
        this.logger.log(`Rejection message sent to ${campaignPatient.phone}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Failed to send rejection message to ${campaignPatient.phone}: ${msg}`,
        );
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
