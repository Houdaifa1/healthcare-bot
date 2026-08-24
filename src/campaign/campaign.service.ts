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
import { ClinOpsPatient, ClinOpsDoctor } from '../clinops/clinops.types';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { SessionsService } from '../sessions/sessions.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { HandoffService } from '../handoff/handoff.service';
import { QUEUES, JOBS } from '../queue/queue.constants';
import { Campaign, CampaignStatus, CampaignPatientStatus, ConversationOutcome, BookingSource } from '@prisma/client';

export interface CampaignOutboundJob {
  campaignPatientId: string;
  campaignId: string;
  clinicId: string;
}

@Injectable()
export class CampaignService {
  private readonly logger = new Logger(CampaignService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clinops: ClinOpsService,
    private readonly sessionsService: SessionsService,
    private readonly whatsappService: WhatsAppService,
    private readonly handoffService: HandoffService,
    @InjectQueue(QUEUES.CAMPAIGN_OUTBOUND)
    private readonly outboundQueue: Queue,
  ) { }

  // ═══════════════════════════════════════════════════════════════════════════
  // CREATE
  // ═══════════════════════════════════════════════════════════════════════════

  async create(clinicId: string, dto: CreateCampaignDto): Promise<Campaign> {
    this.validateFilters(dto);

    // Always created as DRAFT, never auto-launched — a campaign send is a
    // real, irreversible WhatsApp message to real patients, so staff must
    // explicitly review the matched patient count (GET .../preview) and then
    // call launch as a separate, deliberate action. scheduledStartAt only
    // decides what launch() does once called: launch a scheduled campaign
    // immediately moves it to SCHEDULED and the cron picks it up later;
    // without one, launch() sends right away — but only once someone
    // actually clicks Launch.
    return this.prisma.campaign.create({
      data: {
        clinicId,
        name: dto.name,
        status: CampaignStatus.DRAFT,
        scheduledStartAt: dto.scheduledStartAt ? new Date(dto.scheduledStartAt) : undefined,
        filterDateFrom: dto.filterDateFrom ? new Date(dto.filterDateFrom) : undefined,
        filterDateTo: dto.filterDateTo ? new Date(dto.filterDateTo) : undefined,
        filterDoctors: dto.filterDoctors ?? [],
        filterMotifs: dto.filterMotifs ?? [],
        filterCinPassports: dto.filterCinPassports ?? [],
        filterPhoneNumbers: dto.filterPhoneNumbers ?? [],
        onlyVerifiedNumbers: dto.onlyVerifiedNumbers ?? true,
        notificationPhone: dto.notificationPhone,
        delayHours: dto.delayHours,
        reminderCount: dto.reminderCount,
        reminderIntervalHours: dto.reminderIntervalHours,
        aiMaxTurns: dto.aiMaxTurns,
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FIND ALL
  // ═══════════════════════════════════════════════════════════════════════════

  async findAll(clinicId: string): Promise<Campaign[]> {
    return this.prisma.campaign.findMany({
      where: { clinicId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FIND ONE — single campaign with its patients
  // ═══════════════════════════════════════════════════════════════════════════

  async findOne(clinicId: string, id: string): Promise<Campaign & { patients: any[] }> {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id, clinicId },
      include: {
        patients: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!campaign) {
      throw new NotFoundException(`Campaign ${id} not found`);
    }

    // Enrich each patient with their live Redis session status
    const enrichedPatients = await Promise.all(
      campaign.patients.map(async (patient) => {
        const normalizedPhone = patient.phone.replace(/^\+/, '').replace(/\s/g, '');
        const redisSession = await this.sessionsService.getCampaignSession(normalizedPhone);
        return {
          ...patient,
          sessionStatus: redisSession?.status ?? null,
        };
      }),
    );

    return {
      ...campaign,
      patients: enrichedPatients,
    } as Campaign & { patients: any[] };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UPDATE
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
      dto.filterDateTo !== undefined || dto.filterDoctors !== undefined ||
      dto.filterMotifs !== undefined || dto.filterCinPassports !== undefined ||
      dto.filterPhoneNumbers !== undefined
    ) {
      this.validateFilters({ ...campaign, ...dto } as any);
    }

    return this.prisma.campaign.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.scheduledStartAt !== undefined && { scheduledStartAt: dto.scheduledStartAt ? new Date(dto.scheduledStartAt) : null }),
        ...(dto.filterDateFrom !== undefined && { filterDateFrom: dto.filterDateFrom ? new Date(dto.filterDateFrom) : null }),
        ...(dto.filterDateTo !== undefined && { filterDateTo: dto.filterDateTo ? new Date(dto.filterDateTo) : null }),
        ...(dto.filterDoctors !== undefined && { filterDoctors: dto.filterDoctors ?? [] }),
        ...(dto.filterMotifs !== undefined && { filterMotifs: dto.filterMotifs ?? [] }),
        ...(dto.filterCinPassports !== undefined && { filterCinPassports: dto.filterCinPassports ?? [] }),
        ...(dto.filterPhoneNumbers !== undefined && { filterPhoneNumbers: dto.filterPhoneNumbers ?? [] }),
        ...(dto.onlyVerifiedNumbers !== undefined && { onlyVerifiedNumbers: dto.onlyVerifiedNumbers }),
        ...(dto.notificationPhone !== undefined && { notificationPhone: dto.notificationPhone ?? null }),
        ...(dto.delayHours !== undefined && { delayHours: dto.delayHours ?? null }),
        ...(dto.reminderCount !== undefined && { reminderCount: dto.reminderCount ?? null }),
        ...(dto.reminderIntervalHours !== undefined && { reminderIntervalHours: dto.reminderIntervalHours ?? null }),
        ...(dto.aiMaxTurns !== undefined && { aiMaxTurns: dto.aiMaxTurns ?? null }),
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

  // Ad-hoc preview, no campaign created yet — lets the creation form show a
  // live "N patients match" while the admin is still filling in filters,
  // instead of forcing a create-then-preview round trip.
  async previewFilters(
    filters: Pick<CreateCampaignDto,
      'filterMotifs' | 'filterCinPassports' | 'filterPhoneNumbers' | 'onlyVerifiedNumbers' |
      'filterDoctors' | 'filterDateFrom' | 'filterDateTo'>,
  ): Promise<{ count: number; patients: ClinOpsPatient[] }> {
    this.validateFilters(filters);
    const patients = await this.matchPatients({
      filterMotifs: filters.filterMotifs,
      filterCinPassports: filters.filterCinPassports,
      filterPhoneNumbers: filters.filterPhoneNumbers,
      onlyVerifiedNumbers: filters.onlyVerifiedNumbers,
      filterDoctors: filters.filterDoctors,
      filterDateFrom: filters.filterDateFrom,
      filterDateTo: filters.filterDateTo,
    });
    return { count: patients.length, patients };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TARGETING OPTIONS — exact specialties/doctors from ClinOps for the create-
  // campaign picker, so staff select from the real list instead of typing
  // free text. Composed entirely from documented ClinOps endpoints
  // (getSpeciality + getDoctorsBySpeciality per specialty); no hardcoded list.
  // ═══════════════════════════════════════════════════════════════════════════

  async getTargetingOptions(): Promise<{
    specialties: { specialityId: number; specialityLabel: string }[];
    doctors: (ClinOpsDoctor & { specialityIds: number[] })[];
  }> {
    const specialties = await this.clinops.getSpecialities();

    const doctorsById = new Map<number, ClinOpsDoctor & { specialityIds: number[] }>();
    for (const specialty of specialties) {
      const doctors = await this.clinops.getDoctorsBySpeciality(specialty.specialityId);
      for (const doctor of doctors) {
        const existing = doctorsById.get(doctor.doctorId);
        if (existing) {
          existing.specialityIds.push(specialty.specialityId);
        } else {
          doctorsById.set(doctor.doctorId, { ...doctor, specialityIds: [specialty.specialityId] });
        }
      }
    }

    return { specialties, doctors: Array.from(doctorsById.values()) };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LAUNCH
  // ═══════════════════════════════════════════════════════════════════════════

  async launch(clinicId: string, id: string): Promise<Campaign> {
    const campaign = await this.findOneRaw(clinicId, id);

    if (
      campaign.status !== CampaignStatus.DRAFT &&
      campaign.status !== CampaignStatus.SCHEDULED
    ) {
      throw new ConflictException(
        `Campaign "${campaign.name}" is already ${campaign.status}`,
      );
    }

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
        data: { status: CampaignStatus.SCHEDULED },
      });
    }

    return this.executeLaunch(campaign);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CANCEL SCHEDULE
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
        status: CampaignStatus.DRAFT,
        scheduledStartAt: null,
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCHEDULER — called every minute by cron
  // ═══════════════════════════════════════════════════════════════════════════

  async executeScheduledCampaigns(): Promise<void> {
    const dueCampaigns = await this.prisma.campaign.findMany({
      where: {
        status: CampaignStatus.SCHEDULED,
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
  // STOP
  // ═══════════════════════════════════════════════════════════════════════════

  async stop(clinicId: string, id: string): Promise<Campaign> {
    const campaign = await this.findOneRaw(clinicId, id);

    if (campaign.status !== CampaignStatus.RUNNING) {
      throw new ConflictException(
        `Campaign "${campaign.name}" cannot be stopped from status ${campaign.status}`,
      );
    }

    return this.prisma.campaign.update({
      where: { id },
      data: { status: CampaignStatus.STOPPED, completedAt: new Date() },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DELETE
  // ═══════════════════════════════════════════════════════════════════════════

  async remove(clinicId: string, id: string): Promise<void> {
    const campaign = await this.findOneRaw(clinicId, id);

    if (campaign.status === CampaignStatus.RUNNING) {
      throw new ConflictException(
        `Campaign "${campaign.name}" is RUNNING — stop it before deleting`,
      );
    }

    const unresolvedComplaints = await this.prisma.complaint.count({
      where: {
        clinicId,
        status: { not: 'RESOLVED' },
        campaignPatient: { campaignId: id },
      },
    });

    if (unresolvedComplaints > 0) {
      throw new ConflictException(
        `${unresolvedComplaints} unresolved complaint(s) in this campaign — resolve them before deleting`,
      );
    }

    // ── Purge all Redis campaign sessions for patients in this campaign ────
    // MUST happen before DB deletion — we need the phone numbers from the DB.
    // If this is skipped, orphaned Redis sessions keep routing inbound messages
    // to dead CampaignPatient records and the patient can never reach the bot.
    const patients = await this.prisma.campaignPatient.findMany({
      where: { campaignId: id },
      select: { phone: true },
    });

    let purgedSessions = 0;
    for (const patient of patients) {
      try {
        const session = await this.sessionsService.getCampaignSession(patient.phone);
        if (session) {
          await this.sessionsService.deleteCampaignSession(patient.phone);
          purgedSessions++;
        }
      } catch (err: any) {
        // Redis failure must not block DB deletion — log and continue
        this.logger.warn(
          `Failed to purge Redis session for ${patient.phone} during campaign delete: ${err.message}`,
        );
      }
    }

    if (purgedSessions > 0) {
      this.logger.log(
        `Purged ${purgedSessions} Redis session(s) before deleting campaign ${id}`,
      );
    }

    // ── Delete DB records in FK order ──────────────────────────────────────
    await this.prisma.complaint.deleteMany({
      where: { campaignPatient: { campaignId: id } },
    });

    await this.prisma.bookingRequest.deleteMany({
      where: { campaignPatient: { campaignId: id } },
    });

    // Handoff.campaignPatientId has no cascade delete — without this, deleting
    // a campaign patient that ever had a Handoff row (patient-initiated or
    // staff take-over) fails on the FK constraint.
    await this.prisma.handoff.deleteMany({
      where: { campaignPatient: { campaignId: id } },
    });

    await this.prisma.campaignPatient.deleteMany({
      where: { campaignId: id },
    });

    await this.prisma.campaign.delete({
      where: { id },
    });

    this.logger.log(`Campaign "${campaign.name}" (${id}) deleted`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE — EXECUTE LAUNCH
  // ═══════════════════════════════════════════════════════════════════════════

  private async executeLaunch(campaign: Campaign): Promise<Campaign> {
    const clinic = await this.prisma.clinic.findUnique({ where: { id: campaign.clinicId } });
    if (!clinic) throw new NotFoundException('Clinic not found');

    const clinopsPatients = await this.fetchPatientsFromClinOps(campaign);

    if (clinopsPatients.length === 0) {
      if (campaign.status === CampaignStatus.SCHEDULED) {
        this.logger.warn(`Scheduled campaign "${campaign.name}" has no matching patients — marking COMPLETED`);
        return this.prisma.campaign.update({
          where: { id: campaign.id },
          data: {
            status: CampaignStatus.COMPLETED,
            completedAt: new Date(),
          },
        });
      }
      throw new BadRequestException(
        'No patients found matching the campaign filters. Adjust filters and try again.',
      );
    }

    const delayHours = campaign.delayHours !== null && campaign.delayHours !== undefined
      ? campaign.delayHours
      : clinic.campaignDelayHours;

    const delayMs = delayHours * 60 * 60 * 1000;

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
            campaignId: campaign.id,
            clinicId: campaign.clinicId,
            clinopsPatientId: patient.patient_id,
            patientName: patient.patient,
            cin: patient.cin,
            sexe: patient.sexe,
            ageYears: patient.age_years,
            ville: patient.ville,
            pays: patient.pays,
            phone: patient.numeroTelephonePrincipale,
            phoneSecondaire: patient.numeroTelephoneSecondaire,
            soldeImpaye: patient.solde_impaye,
            visitDate: new Date(patient.date_derniere_admission),
            prestation: patient.prestation,
            medecinTraitant: patient.medecin_traitant,
            patientSnapshot: { patient, history } as any,
          },
        });

        const jobData: CampaignOutboundJob = {
          campaignPatientId: record.id,
          campaignId: campaign.id,
          clinicId: campaign.clinicId,
        };

        await this.outboundQueue.add(JOBS.SEND_CAMPAIGN_OUTBOUND, jobData, {
          delay: delayMs,
          attempts: 3,
          backoff: { type: 'exponential', delay: 10_000 },
          removeOnComplete: 50,
          removeOnFail: 20,
        });

        this.logger.log(
          `Queued outbound for patient ${patient.patient_id} (${patient.patient}) with delay ${delayHours}h`,
        );
      }

      await tx.campaign.update({
        where: { id: campaign.id },
        data: {
          status: CampaignStatus.RUNNING,
          launchedAt: new Date(),
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
    return this.matchPatients({
      filterMotifs: campaign.filterMotifs,
      filterCinPassports: campaign.filterCinPassports,
      filterPhoneNumbers: campaign.filterPhoneNumbers,
      onlyVerifiedNumbers: campaign.onlyVerifiedNumbers,
      filterDoctors: campaign.filterDoctors,
      filterDateFrom: campaign.filterDateFrom ? campaign.filterDateFrom.toISOString().slice(0, 10) : null,
      filterDateTo: campaign.filterDateTo ? campaign.filterDateTo.toISOString().slice(0, 10) : null,
    });
  }

  // Shared by fetchPatientsFromClinOps (persisted campaign) and
  // previewFilters (ad-hoc, pre-creation) below.
  private async matchPatients(filters: {
    filterMotifs?: string[] | null;
    filterCinPassports?: string[] | null;
    filterPhoneNumbers?: string[] | null;
    onlyVerifiedNumbers?: boolean | null;
    filterDoctors?: string[] | null;
    filterDateFrom?: string | null; // YYYY-MM-DD
    filterDateTo?: string | null;   // YYYY-MM-DD
  }): Promise<ClinOpsPatient[]> {
    // At least one of filterMotifs/filterCinPassports/filterPhoneNumbers is
    // required (enforced in validateFilters) — these mirror the three real
    // searchPatientsInfos fields exactly (motif, cin_passeport,
    // numeroTelephone). The API only accepts a single value per field per
    // call, so each entry gets its own call, merged and de-duplicated by
    // patient_id. filterDoctors/filterDateFrom/filterDateTo narrow the result
    // locally afterward — the API has no doctor parameter, and its date
    // filter is a single exact day, not a range, so a range can't be pushed
    // server-side either.
    const onlyVerified = filters.onlyVerifiedNumbers ?? true;
    const patientsById = new Map<number, ClinOpsPatient>();

    for (const motif of filters.filterMotifs ?? []) {
      const matched = await this.clinops.searchPatients({ motif, OnlyVerifiedNumbers: onlyVerified });
      for (const patient of matched) patientsById.set(patient.patient_id, patient);
    }
    for (const cin_passeport of filters.filterCinPassports ?? []) {
      const matched = await this.clinops.searchPatients({ cin_passeport, OnlyVerifiedNumbers: onlyVerified });
      for (const patient of matched) patientsById.set(patient.patient_id, patient);
    }
    for (const numeroTelephone of filters.filterPhoneNumbers ?? []) {
      const matched = await this.clinops.searchPatients({ numeroTelephone, OnlyVerifiedNumbers: onlyVerified });
      for (const patient of matched) patientsById.set(patient.patient_id, patient);
    }

    let patients = Array.from(patientsById.values());

    if (filters.filterDateFrom || filters.filterDateTo) {
      const fromTs = filters.filterDateFrom
        ? new Date(filters.filterDateFrom).setHours(0, 0, 0, 0)
        : 0;
      const toTs = filters.filterDateTo
        ? new Date(filters.filterDateTo).setHours(23, 59, 59, 999)
        : Infinity;

      patients = patients.filter((p) => {
        const visitTs = new Date(p.date_derniere_admission).getTime();
        return visitTs >= fromTs && visitTs <= toTs;
      });
    }

    if (filters.filterDoctors?.length) {
      const doctorSet = new Set(filters.filterDoctors.map((d) => d.toLowerCase()));
      patients = patients.filter((p) => doctorSet.has(p.medecin_traitant.toLowerCase()));
    }

    return patients;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GET CONVERSATION HISTORY
  // ═══════════════════════════════════════════════════════════════════════════

  async getConversation(clinicId: string, campaignId: string, patientId: string) {
    const patient = await this.prisma.campaignPatient.findFirst({
      where: { id: patientId, campaignId, clinicId },
      select: {
        id: true,
        patientName: true,
        phone: true,
        messages: true,
        turnCount: true,
        language: true,
        status: true,
        outcome: true,
        createdAt: true,
        updatedAt: true,
        complaints: true,
        bookingRequests: true,
      },
    });

    if (!patient) {
      throw new NotFoundException(`Patient ${patientId} not found in campaign ${campaignId}`);
    }

    const normalizedPhone = patient.phone.replace(/^\+/, '').replace(/\s/g, '');
    const redisSession = await this.sessionsService.getCampaignSession(normalizedPhone);

    // Redis holds the live transcript while a turn is in flight; Postgres is
    // only caught up once the turn ends. Prefer whichever is further ahead so
    // the dashboard shows messages as they happen, and never fewer than the
    // persisted history (a stale//recreated session must not hide messages).
    const dbMessages = (patient.messages as any[]) ?? [];
    const liveMessages = redisSession?.messages ?? [];
    const messages = liveMessages.length > dbMessages.length ? liveMessages : dbMessages;

    return {
      ...patient,
      messages,
      sessionStatus: redisSession?.status ?? null,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TAKE OVER — PAUSE BOT, LET STAFF HANDLE
  // ═══════════════════════════════════════════════════════════════════════════

  async takeOverConversation(clinicId: string, campaignId: string, patientId: string) {
    const patient = await this.prisma.campaignPatient.findFirst({
      where: { id: patientId, campaignId, clinicId },
      include: { campaign: true },
    });

    if (!patient) {
      throw new NotFoundException(`Patient ${patientId} not found in campaign ${campaignId}`);
    }

    const normalizedPhone = patient.phone.replace(/^\+/, '').replace(/\s/g, '');
    const existingSession = await this.sessionsService.getCampaignSession(normalizedPhone);
    if (existingSession) {
      existingSession.status = 'admin_handling';
      existingSession.phone = normalizedPhone;
      await this.sessionsService.saveCampaignSession(existingSession);
    } else {
      await this.sessionsService.saveCampaignSession({
        phone: normalizedPhone,
        campaignPatientId: patient.id,
        clinicId,
        patientSnapshot: patient.patientSnapshot as Record<string, any>,
        language: patient.language ?? null,
        messages: (patient.messages as any[]) ?? [],
        turnCount: patient.turnCount,
        remindersSent: patient.remindersSent,
        status: 'admin_handling',
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
      });
    }

    // Update patient status to COMPLETED to stop reminder cycle
    await this.prisma.campaignPatient.update({
      where: { id: patientId },
      data: {
        status: CampaignPatientStatus.COMPLETED,
        outcome: ConversationOutcome.HANDED_OFF,
      },
    });

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { completedCount: { increment: 1 } },
    });

    // Staff-initiated take-over (patient never asked for a human) still needs
    // a Handoff row — the "Sessions en direct" dashboard page reads only from
    // the Handoff table, not from CampaignPatient/Redis session state. Without
    // this, clicking "take over" navigates staff to a live-session view with
    // nothing in it.
    await this.handoffService.createHandoff({
      clinicId,
      source: BookingSource.CAMPAIGN,
      phone: normalizedPhone,
      patientName: patient.patientName,
      campaignPatientId: patient.id,
      reason: 'Staff take-over',
      language: patient.language,
      messages: (patient.messages as any[]) ?? [],
      ageYears: patient.ageYears,
      ville: patient.ville,
      visitDate: patient.visitDate,
      prestation: patient.prestation,
      medecinTraitant: patient.medecinTraitant,
    });

    return { success: true, patientId, status: 'admin_handling' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════
  private validateFilters(
    dto: Pick<CreateCampaignDto,
      'filterDateFrom' | 'filterDateTo' | 'filterDoctors' |
      'filterMotifs' | 'filterCinPassports' | 'filterPhoneNumbers'>,
  ): void {
    // searchPatientsInfos requires at least one of motif, cin_passeport, or
    // numeroTelephone — mirrored exactly here. See the comment on
    // CreateCampaignDto for why these three (and only these three) can match
    // patients server-side.
    if (!dto.filterMotifs?.length && !dto.filterCinPassports?.length && !dto.filterPhoneNumbers?.length) {
      throw new BadRequestException(
        'At least one of filterMotifs, filterCinPassports, or filterPhoneNumbers is required — the ClinOps API has no way to list patients without one of these',
      );
    }

    if (dto.filterDateFrom && dto.filterDateTo) {
      if (new Date(dto.filterDateFrom) > new Date(dto.filterDateTo)) {
        throw new BadRequestException('filterDateFrom must be before filterDateTo');
      }
    }
  }
}