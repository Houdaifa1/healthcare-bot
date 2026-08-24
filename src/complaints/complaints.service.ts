import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Complaint, ComplaintStatus, Prisma } from '@prisma/client';

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
            id:           true,
            patientName:  true,
            phone:        true,
            campaignId:   true,
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
            id:               true,
            patientName:      true,
            phone:            true,
            campaignId:       true,
            visitDate:        true,
            prestation:       true,
            medecinTraitant:  true,
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
  // STATUS TIMESTAMPS — one rule, shared by the single and bulk paths
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // The lifecycle is NEW → REVIEWED → RESOLVED, and staff can walk it
  // backwards (reopening a resolved complaint). Moving backwards must clear
  // the timestamps that no longer apply, otherwise a NEW complaint keeps a
  // resolvedAt and the dashboard reports it as both open and resolved.

  private statusTimestamps(status: ComplaintStatus): {
    /** Omitted (not null) means "leave whatever is already stored". */
    reviewedAt?: Date | null;
    resolvedAt: Date | null;
  } {
    const now = new Date();

    if (status === ComplaintStatus.RESOLVED) {
      // reviewedAt is deliberately left as-is: it records that the complaint
      // was genuinely triaged, which resolving does not undo.
      return { resolvedAt: now };
    }

    if (status === ComplaintStatus.REVIEWED) {
      return { reviewedAt: now, resolvedAt: null };
    }

    // NEW — back to untriaged, so neither timestamp applies any more.
    return { reviewedAt: null, resolvedAt: null };
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

    const { reviewedAt, resolvedAt } = this.statusTimestamps(status);

    const data: Prisma.ComplaintUpdateInput = { status, resolvedAt };
    if (reviewedAt !== undefined) data.reviewedAt = reviewedAt;

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
      data:  { staffNote: staffNote.trim() || null },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UPDATE STATUS FOR A WHOLE PATIENT — "resolve all for this patient"
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Scoped to a single CampaignPatient (not a phone number): the same person
  // enrolled in two campaigns has two CampaignPatient rows, and staff act on
  // one campaign's context at a time. This is also the exact scope
  // CampaignService.remove() counts when it refuses to delete a campaign with
  // unresolved complaints.
  //
  // One updateMany rather than N single updates: atomic, one round-trip, and
  // immune to a complaint arriving between the read and the write. The
  // `status: { not: status }` guard means already-resolved rows keep their
  // original resolvedAt instead of having it stamped again.

  async updateStatusForPatient(
    clinicId: string,
    campaignPatientId: string,
    status: ComplaintStatus,
  ): Promise<{ count: number }> {
    const total = await this.prisma.complaint.count({
      where: { clinicId, campaignPatientId },
    });

    if (total === 0) {
      throw new NotFoundException(
        `No complaints found for patient ${campaignPatientId}`,
      );
    }

    const { reviewedAt, resolvedAt } = this.statusTimestamps(status);

    const data: Prisma.ComplaintUpdateManyMutationInput = { status, resolvedAt };
    if (reviewedAt !== undefined) data.reviewedAt = reviewedAt;

    const { count } = await this.prisma.complaint.updateMany({
      where: { clinicId, campaignPatientId, status: { not: status } },
      data,
    });

    this.logger.log(
      `Updated ${count} complaint(s) to ${status} for patient ${campaignPatientId} in clinic ${clinicId}`,
    );

    return { count };
  }
}
