import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Complaint, ComplaintStatus } from '@prisma/client';

@Injectable()
export class ComplaintsService {
  private readonly logger = new Logger(ComplaintsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // FIND ALL — filtered by clinicId + optional query filters
  // ═══════════════════════════════════════════════════════════════════════════

  async findAll(
    clinicId: string,
    filters: {
      campaignId?: string;
      status?: ComplaintStatus;
      severity?: string;
      type?: string;
    },
  ): Promise<Complaint[]> {
    const where: Record<string, any> = { clinicId };

    if (filters.campaignId) {
      where.campaignPatient = { campaignId: filters.campaignId };
    }

    if (filters.status) {
      where.status = filters.status;
    }

    if (filters.severity) {
      where.severity = filters.severity;
    }

    if (filters.type) {
      where.type = filters.type;
    }

    this.logger.log(
      `Finding complaints for clinic ${clinicId} with filters: ${JSON.stringify(filters)}`,
    );

    return this.prisma.complaint.findMany({
      where,
      include: {
        campaignPatient: {
          select: {
            id: true,
            patientName: true,
            phone: true,
            campaignId: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FIND ONE — single complaint scoped to clinicId
  // ═══════════════════════════════════════════════════════════════════════════

  async findOne(clinicId: string, id: string): Promise<Complaint> {
    const complaint = await this.prisma.complaint.findFirst({
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
      },
    });

    if (!complaint) {
      throw new NotFoundException(`Complaint ${id} not found`);
    }

    return complaint;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UPDATE STATUS — sets reviewedAt / resolvedAt automatically
  // ═══════════════════════════════════════════════════════════════════════════

  async updateStatus(
    clinicId: string,
    id: string,
    status: ComplaintStatus,
  ): Promise<Complaint> {
    // Verify ownership
    await this.findOne(clinicId, id);

    const data: Record<string, any> = { status };

    if (status === ComplaintStatus.REVIEWED) {
      data.reviewedAt = new Date();
    }

    if (status === ComplaintStatus.RESOLVED) {
      data.resolvedAt = new Date();
    }

    this.logger.log(
      `Updating complaint ${id} status to ${status} for clinic ${clinicId}`,
    );

    return this.prisma.complaint.update({
      where: { id },
      data,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UPDATE STAFF NOTE
  // ═══════════════════════════════════════════════════════════════════════════

  async updateStaffNote(
    clinicId: string,
    id: string,
    staffNote: string,
  ): Promise<Complaint> {
    // Verify ownership
    await this.findOne(clinicId, id);

    this.logger.log(
      `Updating staff note for complaint ${id} in clinic ${clinicId}`,
    );

    return this.prisma.complaint.update({
      where: { id },
      data: { staffNote },
    });
  }
}
