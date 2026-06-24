import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { ClinOpsService } from '../clinops/clinops.service';
import { ClinOpsPatient } from '../clinops/clinops.types';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { QUEUES, JOBS } from '../queue/queue.constants';
import { Campaign, CampaignStatus, CampaignPatientStatus } from '@prisma/client';

export interface CampaignOutboundJob {
  campaignPatientId: string;
  campaignId:        string;
  clinicId:          string;
}

@Injectable()
export class CampaignService {
  private readonly logger = new Logger(CampaignService.name);

  constructor(
    private readonly prisma:       PrismaService,
    private readonly clinops:      ClinOpsService,
    @InjectQueue(QUEUES.CAMPAIGN_OUTBOUND)
    private readonly outboundQueue: Queue,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // CREATE — creates a DRAFT campaign, no patients loaded yet
  // ═══════════════════════════════════════════════════════════════════════════

  async create(clinicId: string, dto: CreateCampaignDto): Promise<Campaign> {
    this.validateFilters(dto);

    return this.prisma.campaign.create({
      data: {
        clinicId,
        name:                  dto.name,
        status:                CampaignStatus.DRAFT,
        scheduledStartAt:      dto.scheduledStartAt ? new Date(dto.scheduledStartAt) : undefined,
        filterDateFrom:        dto.filterDateFrom ? new Date(dto.filterDateFrom) : undefined,
        filterDateTo:          dto.filterDateTo   ? new Date(dto.filterDateTo)   : undefined,
        filterDoctor:          dto.filterDoctor,
        filterMotif:           dto.filterMotif,
        notificationPhone:     dto.notificationPhone,
        delayHours:            dto.delayHours,
        reminderCount:         dto.reminderCount,
        reminderIntervalHours: dto.reminderIntervalHours,
        aiMaxTurns:            dto.aiMaxTurns,
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FIND ALL
  // ═══════════════════════════════════════════════════════════════════════════

  async findAll(clinicId: string): Promise<Campaign[]> {
    return this.prisma.campaign.findMany({
      where:   { clinicId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FIND ONE — single campaign with its patients
  // ═══════════════════════════════════════════════════════════════════════════

  async findOne(clinicId: string, id: string): Promise<Campaign & { patients: any[] }> {
    const campaign = await this.prisma.campaign.findFirst({
      where:   { id, clinicId },
      include: {
        patients: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!campaign) {
      throw new NotFoundException(`Campaign ${id} not found`);
    }

    return campaign as Campaign & { patients: any[] };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UPDATE — only allowed on DRAFT campaigns
  // ═══════════════════════════════════════════════════════════════════════════

  async update(clinicId: string, id: string, dto: UpdateCampaignDto): Promise<Campaign> {
    const campaign = await this.findOneRaw(clinicId, id);

    if (
      campaign.status !== CampaignStatus.DRAFT &&
      campaign.status !== CampaignStatus.SCHEDULED
    ) {
      throw new ConflictException(
        `Campaign "${campaign.name}" is ${campaign.status} — only DRAFT or SCHEDULED campaigns can be edited`,
      );
    }

    if (
      dto.name !== undefined || dto.filterDateFrom !== undefined ||
      dto.filterDateTo !== undefined || dto.filterDoctor !== undefined ||
      dto.filterMotif !== undefined
    ) {
      this.validateFilters({ ...campaign, ...dto } as any);
    }

    return this.prisma.campaign.update({
      where: { id },
      data: {
        ...(dto.name                  !== undefined && { name: dto.name }),
        ...(dto.scheduledStartAt      !== undefined && { scheduledStartAt: dto.scheduledStartAt ? new Date(dto.scheduledStartAt) : null }),
        ...(dto.filterDateFrom        !== undefined && { filterDateFrom: dto.filterDateFrom ? new Date(dto.filterDateFrom) : null }),
        ...(dto.filterDateTo          !== undefined && { filterDateTo:   dto.filterDateTo   ? new Date(dto.filterDateTo)   : null }),
        ...(dto.filterDoctor          !== undefined && { filterDoctor:   dto.filterDoctor   ?? null }),
        ...(dto.filterMotif           !== undefined && { filterMotif:    dto.filterMotif    ?? null }),
        ...(dto.notificationPhone     !== undefined && { notificationPhone:    dto.notificationPhone    ?? null }),
        ...(dto.delayHours            !== undefined && { delayHours:           dto.delayHours           ?? null }),
        ...(dto.reminderCount         !== undefined && { reminderCount:        dto.reminderCount        ?? null }),
        ...(dto.reminderIntervalHours !== undefined && { reminderIntervalHours: dto.reminderIntervalHours ?? null }),
        ...(dto.aiMaxTurns            !== undefined && { aiMaxTurns:           dto.aiMaxTurns           ?? null }),
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PREVIEW
  // ═══════════════════════════════════════════════════════════════════════════

  async preview(clinicId: string, id: string): Promise<{ count: number; patients: ClinOpsPatient[] }> {
    const campaign = await this.findOneRaw(clinicId, id);
    const patients = await this.fetchPatientsFromClinOps(campaign);
    return { count: patients.length, patients };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LAUNCH
  // ═══════════════════════════════════════════════════════════════════════════

  async launch(clinicId: string, id: string): Promise<Campaign> {
    const campaign = await this.findOneRaw(clinicId, id);

    // Only DRAFT or SCHEDULED campaigns can be launched
    if (
      campaign.status !== CampaignStatus.DRAFT &&
      campaign.status !== CampaignStatus.SCHEDULED
    ) {
      throw new ConflictException(
        `Campaign "${campaign.name}" is already ${campaign.status}`,
      );
    }

    // ── If DRAFT with scheduledStartAt in the future, enter SCHEDULED status ──
    if (
      campaign.status === CampaignStatus.DRAFT &&
      campaign.scheduledStartAt &&
      campaign.scheduledStartAt > new Date()
    ) {
      this.logger.log(
        `Campaign "${campaign.name}" scheduled for ${campaign.scheduledStartAt.toISOString()} — entering SCHEDULED status`,
      );

      return this.prisma.campaign.update({
        where: { id },
        data:  { status: CampaignStatus.SCHEDULED },
      });
    }

    // ── Immediate launch ──
    return this.executeLaunch(campaign);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CANCEL SCHEDULE — revert SCHEDULED campaign back to DRAFT
  // ═══════════════════════════════════════════════════════════════════════════

  async cancelSchedule(clinicId: string, id: string): Promise<Campaign> {
    const campaign = await this.findOneRaw(clinicId, id);

    if (campaign.status !== CampaignStatus.SCHEDULED) {
      throw new ConflictException(
        `Campaign "${campaign.name}" is ${campaign.status} — only SCHEDULED campaigns can have their schedule cancelled`,
      );
    }

    this.logger.log(`Cancelling schedule for campaign "${campaign.name}"`);

    return this.prisma.campaign.update({
      where: { id },
      data: {
        status:           CampaignStatus.DRAFT,
        scheduledStartAt: null,
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCHEDULER — called every minute by cron, launches due campaigns
  // ═══════════════════════════════════════════════════════════════════════════

  async executeScheduledCampaigns(): Promise<void> {
    const dueCampaigns = await this.prisma.campaign.findMany({
      where: {
        status:           CampaignStatus.SCHEDULED,
        scheduledStartAt: { lte: new Date() },
      },
    });

    if (dueCampaigns.length === 0) return;

    this.logger.log(`Found ${dueCampaigns.length} scheduled campaign(s) ready to launch`);

    for (const campaign of dueCampaigns) {
      try {
        this.logger.log(`Auto-launching campaign "${campaign.name}" (${campaign.id})`);
        await this.executeLaunch(campaign);
      } catch (err: any) {
        this.logger.error(
          `Failed to auto-launch campaign "${campaign.name}" (${campaign.id}): ${err.message}`,
        );
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAUSE
  // ═══════════════════════════════════════════════════════════════════════════

  async pause(clinicId: string, id: string): Promise<Campaign> {
    const campaign = await this.findOneRaw(clinicId, id);

    if (campaign.status !== CampaignStatus.RUNNING) {
      throw new ConflictException(
        `Campaign "${campaign.name}" is not RUNNING — cannot pause`,
      );
    }

    return this.prisma.campaign.update({
      where: { id },
      data:  { status: CampaignStatus.PAUSED },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RESUME — re-queues all PARKED patients with a 1-minute delay
  // ═══════════════════════════════════════════════════════════════════════════

  async resume(clinicId: string, id: string): Promise<Campaign> {
    const campaign = await this.findOneRaw(clinicId, id);

    if (campaign.status !== CampaignStatus.PAUSED) {
      throw new ConflictException(
        `Campaign "${campaign.name}" is not PAUSED — cannot resume`,
      );
    }

    // Set campaign RUNNING first so the processor sees RUNNING when jobs fire
    await this.prisma.campaign.update({
      where: { id },
      data:  { status: CampaignStatus.RUNNING },
    });

    // Find all patients that were parked while the campaign was paused
    const parkedPatients = await this.prisma.campaignPatient.findMany({
      where: {
        campaignId: id,
        status:     CampaignPatientStatus.PARKED,
      },
    });

    if (parkedPatients.length === 0) {
      this.logger.log(`Campaign ${id} resumed — no parked patients to re-queue`);
      return this.findOneRaw(clinicId, id);
    }

    // Re-queue all parked patients with a 1-minute delay
    // Short delay gives the DB update time to propagate before jobs fire
    const RESUME_DELAY_MS = 60 * 1000;

    for (const patient of parkedPatients) {
      const jobData: CampaignOutboundJob = {
        campaignPatientId: patient.id,
        campaignId:        id,
        clinicId,
      };

      await this.outboundQueue.add(JOBS.SEND_CAMPAIGN_OUTBOUND, jobData, {
        delay:            RESUME_DELAY_MS,
        attempts:         3,
        backoff:          { type: 'exponential', delay: 10_000 },
        removeOnComplete: 50,
        removeOnFail:     20,
      });
    }

    this.logger.log(
      `Campaign ${id} resumed — re-queued ${parkedPatients.length} parked patients`,
    );

    return this.findOneRaw(clinicId, id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STOP
  // ═══════════════════════════════════════════════════════════════════════════

  async stop(clinicId: string, id: string): Promise<Campaign> {
    const campaign = await this.findOneRaw(clinicId, id);

    if (
      campaign.status !== CampaignStatus.RUNNING &&
      campaign.status !== CampaignStatus.PAUSED
    ) {
      throw new ConflictException(
        `Campaign "${campaign.name}" cannot be stopped from status ${campaign.status}`,
      );
    }

    return this.prisma.campaign.update({
      where: { id },
      data:  { status: CampaignStatus.STOPPED, completedAt: new Date() },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DELETE — only allowed on DRAFT, STOPPED, COMPLETED, or SCHEDULED campaigns
  // ═══════════════════════════════════════════════════════════════════════════

  async remove(clinicId: string, id: string): Promise<void> {
    const campaign = await this.findOneRaw(clinicId, id);

    if (campaign.status === CampaignStatus.RUNNING) {
      throw new ConflictException(
        `Campaign "${campaign.name}" is RUNNING — stop it before deleting`,
      );
    }

    if (campaign.status === CampaignStatus.PAUSED) {
      throw new ConflictException(
        `Campaign "${campaign.name}" is PAUSED — stop or resume it before deleting`,
      );
    }

    // Delete all campaign patients first (cascade)
    await this.prisma.campaignPatient.deleteMany({
      where: { campaignId: id },
    });

    await this.prisma.campaign.delete({
      where: { id },
    });

    this.logger.log(`Campaign "${campaign.name}" (${id}) deleted`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE — EXECUTE LAUNCH (shared by launch() and scheduler)
  // ═══════════════════════════════════════════════════════════════════════════

  private async executeLaunch(campaign: Campaign): Promise<Campaign> {
    const clinic = await this.prisma.clinic.findUnique({ where: { id: campaign.clinicId } });
    if (!clinic) throw new NotFoundException('Clinic not found');

    const clinopsPatients = await this.fetchPatientsFromClinOps(campaign);

    if (clinopsPatients.length === 0) {
      // If scheduled and no patients, move to COMPLETED with 0 count
      if (campaign.status === CampaignStatus.SCHEDULED) {
        this.logger.warn(`Scheduled campaign "${campaign.name}" has no matching patients — marking COMPLETED`);
        return this.prisma.campaign.update({
          where: { id: campaign.id },
          data: {
            status:      CampaignStatus.COMPLETED,
            completedAt: new Date(),
          },
        });
      }
      throw new BadRequestException(
        'No patients found matching the campaign filters. Adjust filters and try again.',
      );
    }

    const delayHours = campaign.delayHours ?? clinic.campaignDelayHours;
    const delayMs    = delayHours * 60 * 60 * 1000;

    await this.prisma.$transaction(async (tx) => {
      for (const patient of clinopsPatients) {
        if (!patient.numeroTelephonePrincipale) {
          this.logger.warn(
            `Skipping patient ${patient.patient_id} (${patient.patient}) — no phone number`,
          );
          continue;
        }

        let history = null;
        try {
          const identifier = patient.cin ?? patient.numeroTelephonePrincipale;
          history = await this.clinops.getPatientHistory(identifier);
        } catch (err: any) {
          this.logger.warn(
            `Could not fetch history for patient ${patient.patient_id}: ${err.message}`,
          );
        }

        const record = await tx.campaignPatient.create({
          data: {
            campaignId:       campaign.id,
            clinicId:         campaign.clinicId,
            clinopsPatientId: patient.patient_id,
            patientName:      patient.patient,
            cin:              patient.cin,
            sexe:             patient.sexe,
            ageYears:         patient.age_years,
            ville:            patient.ville,
            pays:             patient.pays,
            phone:            patient.numeroTelephonePrincipale,
            phoneSecondaire:  patient.numeroTelephoneSecondaire,
            soldeImpaye:      patient.solde_impaye,
            visitDate:        new Date(patient.date_derniere_admission),
            prestation:       patient.prestation,
            medecinTraitant:  patient.medecin_traitant,
            patientSnapshot:  { patient, history } as any,
          },
        });

        const jobData: CampaignOutboundJob = {
          campaignPatientId: record.id,
          campaignId:        campaign.id,
          clinicId:          campaign.clinicId,
        };

        await this.outboundQueue.add(JOBS.SEND_CAMPAIGN_OUTBOUND, jobData, {
          delay:            delayMs,
          attempts:         3,
          backoff:          { type: 'exponential', delay: 10_000 },
          removeOnComplete: 50,
          removeOnFail:     20,
        });

        this.logger.log(
          `Queued outbound for patient ${patient.patient_id} (${patient.patient}) with delay ${delayHours}h`,
        );
      }

      await tx.campaign.update({
        where: { id: campaign.id },
        data: {
          status:        CampaignStatus.RUNNING,
          launchedAt:    new Date(),
          targetedCount: clinopsPatients.length,
        },
      });
    });

    return this.findOneRaw(campaign.clinicId, campaign.id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  private async findOneRaw(clinicId: string, id: string): Promise<Campaign> {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id, clinicId },
    });

    if (!campaign) {
      throw new NotFoundException(`Campaign ${id} not found`);
    }

    return campaign;
  }

  private async fetchPatientsFromClinOps(campaign: Campaign): Promise<ClinOpsPatient[]> {
    const filters: Record<string, any> = {};

    if (campaign.filterMotif) filters.motif = campaign.filterMotif;

    // Do NOT pass date_derniere_consultation to ClinOps search — it only matches
    // exact dates. We do date range filtering post-search below.
    filters.OnlyVerifiedNumbers = true;

    let patients = await this.clinops.searchPatients(filters);

    // Date range filtering — post-search
    if (campaign.filterDateFrom || campaign.filterDateTo) {
      const fromTs = campaign.filterDateFrom
        ? new Date(campaign.filterDateFrom.getFullYear(), campaign.filterDateFrom.getMonth(), campaign.filterDateFrom.getDate()).getTime()
        : 0;
      const toTs = campaign.filterDateTo
        ? new Date(campaign.filterDateTo.getFullYear(), campaign.filterDateTo.getMonth(), campaign.filterDateTo.getDate(), 23, 59, 59).getTime()
        : Infinity;

      patients = patients.filter((p) => {
        const visitTs = new Date(p.date_derniere_admission).getTime();
        return visitTs >= fromTs && visitTs <= toTs;
      });
    }

    if (campaign.filterDoctor) {
      const doctorLower = campaign.filterDoctor.toLowerCase();
      patients = patients.filter(
        (p) => p.medecin_traitant.toLowerCase().includes(doctorLower),
      );
    }

    return patients;
  }

  private validateFilters(
    dto: Pick<CreateCampaignDto, 'filterDateFrom' | 'filterDateTo' | 'filterDoctor' | 'filterMotif'>,
  ): void {
    if (!dto.filterDateFrom && !dto.filterDateTo && !dto.filterDoctor && !dto.filterMotif) {
      throw new BadRequestException(
        'At least one filter is required (filterDateFrom, filterDateTo, filterDoctor, or filterMotif)',
      );
    }

    if (dto.filterDateFrom && dto.filterDateTo) {
      if (new Date(dto.filterDateFrom) > new Date(dto.filterDateTo)) {
        throw new BadRequestException('filterDateFrom must be before filterDateTo');
      }
    }
  }
}