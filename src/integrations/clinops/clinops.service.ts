import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@platform/database/prisma.service';
import { AppointmentStatus, BookingRequestStatus } from '@prisma/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CLINOPS_HTTP, ClinOpsHttpClient } from './clinops.http';
import {
  ClinOpsPatient,
  ClinOpsPatientHistory,
  ClinOpsDoctor,
  ClinOpsSpecialty,
  ClinOpsTimeSlot,
  ClinOpsSearchFilters,
  ClinOpsCreateRDVRequest,
  ClinOpsCreatePatientRequest,
  ClinOpsCreatePatientResponse,
} from './clinops.types';

// Mock-only doctor shape — extends the API type with fields that exist only
// in the JSON files and never leave this service: the specialty filter, and
// a per-doctor weekly schedule used to simulate realistic, varied
// availability instead of one identical static slot list for every doctor.
interface ClinOpsDoctorMock extends ClinOpsDoctor {
  specialite_id: number;
  workingDays:   number[];          // JS Date.getDay() values: 0=Sun..6=Sat
  dailyWindows:  ClinOpsTimeSlot[]; // this doctor's daily availability windows on a working day
}

@Injectable()
export class ClinOpsService implements OnModuleInit {
  private readonly logger = new Logger(ClinOpsService.name);
  private readonly mode: 'mock' | 'live';

  isLiveMode(): boolean { return this.mode === 'live'; }

  // Mock data stores (loaded once at startup)
  private readonly mockPatients: ClinOpsPatient[];
  private readonly mockPatientHistories: Record<string, ClinOpsPatientHistory>;
  private readonly mockDoctors: ClinOpsDoctorMock[];
  private readonly mockSpecialties: ClinOpsSpecialty[];

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    // Built only in live mode — see clinops.module.ts. Never dereferenced in
    // mock mode, and `live()` below turns any slip into a clear error rather
    // than a null-property crash.
    @Inject(CLINOPS_HTTP) private readonly http: ClinOpsHttpClient | null,
  ) {
    this.mode = this.configService.get<string>('clinops.mode') === 'live'
      ? 'live'
      : 'mock';

    this.logger.log(`ClinOpsService running in ${this.mode.toUpperCase()} mode`);

    if (this.mode === 'mock') {
      this.mockPatients        = this.loadJson<ClinOpsPatient[]>('patients.mock.json');
      this.mockPatientHistories = this.loadJson<Record<string, ClinOpsPatientHistory>>('patient-history.mock.json');
      this.mockDoctors         = this.loadJson<ClinOpsDoctorMock[]>('doctors.mock.json');
      this.mockSpecialties     = this.loadJson<ClinOpsSpecialty[]>('specialties.mock.json');

      this.logger.log(
        `Mock data loaded: ${this.mockPatients.length} patients, ` +
        `${Object.keys(this.mockPatientHistories).length} histories, ` +
        `${this.mockDoctors.length} doctors`,
      );
    }
  }

  /**
   * In live mode, prove the configured base URL and credentials work before
   * the first patient does. Deliberately not awaited into the boot sequence:
   * a slow or briefly-unreachable ClinOps must not stop the bot from starting
   * and accepting webhook traffic — it logs loudly instead, and the next real
   * call reports the same failure to its caller.
   */
  onModuleInit(): void {
    if (this.mode !== 'live') return;
    void this.live()
      .verifyCredentials()
      .then((count) =>
        this.logger.log(`ClinOps live connectivity check passed — ${count} specialties returned`),
      )
      .catch((err: unknown) =>
        this.logger.error(
          `ClinOps live connectivity check FAILED — the bot is running but every ClinOps ` +
          `call will fail until this is fixed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }

  /** Live transport, or a clear error if something asked for it in mock mode. */
  private live(): ClinOpsHttpClient {
    if (!this.http) {
      throw new Error(
        'ClinOps live transport was requested while running in mock mode — this is a wiring bug.',
      );
    }
    return this.http;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Patient Search — mirrors searchPatientsInfos
  // ═══════════════════════════════════════════════════════════════════════════

  async searchPatients(filters: ClinOpsSearchFilters): Promise<ClinOpsPatient[]> {
    const { cin_passeport, date_derniere_consultation, motif, numeroTelephone, OnlyVerifiedNumbers } = filters;

    // Per the doc, OnlyVerifiedNumbers is a modifier on the other filters, not
    // itself a qualifying filter — it must not satisfy this requirement alone.
    // Checked before dispatching so both modes fail identically, and so live
    // mode doesn't spend a round trip earning the same 400 back.
    if (!cin_passeport && !motif && !numeroTelephone) {
      throw new BadRequestException(
        'Au moins un filtre requis (cin_passeport, motif, ou numeroTelephone)',
      );
    }

    if (this.mode === 'live') {
      // Undefined keys are dropped rather than sent as null — the doc marks
      // every one of these optional and says nothing about null handling.
      return this.requireList(await this.live().get<ClinOpsPatient[]>(
        'searchPatientsInfos',
        this.compact({
          cin_passeport,
          date_derniere_consultation,
          motif,
          numeroTelephone,
          OnlyVerifiedNumbers,
        }),
      ), 'searchPatientsInfos', p => this.isRecord(p) && Number.isInteger(p.patient_id) &&
        typeof p.patient === 'string' && typeof p.date_derniere_admission === 'string' &&
        typeof p.numeroTelephonePrincipale === 'string');
    }

    let results = [...this.mockPatients];

    if (cin_passeport) {
      const q = cin_passeport.toLowerCase();
      results = results.filter(p => p.cin?.toLowerCase().includes(q));
    }

    if (motif) {
      const q = motif.toLowerCase();
      results = results.filter(p => p.prestation.toLowerCase().includes(q));
    }

    if (numeroTelephone) {
      const q = numeroTelephone.replace(/\s+/g, '').toLowerCase();
      results = results.filter(
        p =>
          p.numeroTelephonePrincipale?.replace(/\s+/g, '').toLowerCase().includes(q) ||
          p.numeroTelephoneSecondaire?.replace(/\s+/g, '').toLowerCase().includes(q),
      );
    }

    if (date_derniere_consultation) {
      results = results.filter(
        p => p.date_derniere_admission?.substring(0, 10) === date_derniere_consultation,
      );
    }

    if (OnlyVerifiedNumbers === true) {
      results = results.filter(p => !!p.numeroTelephonePrincipale);
    }

    // Per API spec: exact CIN matches sort first
    if (cin_passeport) {
      const exact = cin_passeport;
      results.sort((a, b) => (a.cin === exact ? 0 : 1) - (b.cin === exact ? 0 : 1));
    }

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Patient History — mirrors getPatientHistory
  // ═══════════════════════════════════════════════════════════════════════════

  async getPatientHistory(identifier: { cin_passeport?: string; numeroTelephone?: string }): Promise<ClinOpsPatientHistory> {
    const cin = identifier.cin_passeport?.trim();
    const phone = identifier.numeroTelephone?.trim();
    if ((cin ? 1 : 0) + (phone ? 1 : 0) !== 1) {
      throw new BadRequestException(
        'Provide exactly one of cin_passeport or numeroTelephone',
      );
    }

    if (this.mode === 'live') {
      const history = await this.live().get<ClinOpsPatientHistory>('getPatientHistory', cin
        ? { cin_passeport: cin }
        : { numeroTelephone: phone });
      if (!this.isRecord(history) || typeof history.patient !== 'string' ||
          typeof history.solde_impaye !== 'number' || !Array.isArray(history.admissions)) {
        throw new ServiceUnavailableException('ClinOps getPatientHistory response does not match its documented shape');
      }
      return history as unknown as ClinOpsPatientHistory;
    }

    // Try CIN first (exact match)
    if (cin && this.mockPatientHistories[cin]) {
      return this.mockPatientHistories[cin];
    }

    // Fallback: phone lookup — find patient by phone, load history by their CIN
    const normalizedPhone = (phone ?? '').replace(/\s+/g, '').toLowerCase();
    const patient = this.mockPatients.find(
      p =>
        p.numeroTelephonePrincipale?.replace(/\s+/g, '').toLowerCase() === normalizedPhone ||
        p.numeroTelephoneSecondaire?.replace(/\s+/g, '').toLowerCase() === normalizedPhone,
    );

    if (patient?.cin && this.mockPatientHistories[patient.cin]) {
      return this.mockPatientHistories[patient.cin];
    }

    throw new NotFoundException(
      'Aucun patient trouvé avec cet identifiant',
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Specialties — mirrors getSpeciality
  // ═══════════════════════════════════════════════════════════════════════════

  async getSpecialities(): Promise<ClinOpsSpecialty[]> {
    if (this.mode === 'live') {
      // The only documented endpoint that takes no request body at all.
      return this.requireList(await this.live().get<ClinOpsSpecialty[]>('getSpeciality'),
        'getSpeciality', s => this.isRecord(s) && Number.isInteger(s.specialityId) && typeof s.specialityLabel === 'string');
    }
    return this.mockSpecialties;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Doctors by Specialty — mirrors getDoctorsBySpeciality
  // ═══════════════════════════════════════════════════════════════════════════

  async getDoctorsBySpeciality(specialite_id: number): Promise<ClinOpsDoctor[]> {
    if (specialite_id == null) {
      throw new BadRequestException('Le paramètre specialite_id est requis');
    }
    if (!Number.isInteger(specialite_id)) {
      throw new BadRequestException('specialite_id doit être un entier');
    }

    if (this.mode === 'live') {
      return this.requireList(await this.live().get<ClinOpsDoctor[]>('getDoctorsBySpeciality', {
        specialite_id,
      }), 'getDoctorsBySpeciality', d => this.isRecord(d) && Number.isInteger(d.doctorId) && typeof d.doctorLabel === 'string');
    }
    // Strip the mock-only specialite_id field before returning — callers get clean ClinOpsDoctor shapes
    return this.mockDoctors
      .filter(d => d.specialite_id === specialite_id)
      .map(({ doctorId, doctorLabel }) => ({ doctorId, doctorLabel }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Doctor Availability — mirrors getDoctorsAvailability
  // ═══════════════════════════════════════════════════════════════════════════

  async getDoctorsAvailability(nom_medecin: string, date_prevue: string): Promise<ClinOpsTimeSlot[]> {
    if (!nom_medecin) {
      throw new BadRequestException('Le nom du médecin est requis');
    }
    if (!date_prevue) {
      throw new BadRequestException('La date prévue est requise');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date_prevue)) {
      throw new BadRequestException('Format de date invalide (doit être YYYY-MM-DD)');
    }

    if (this.mode === 'live') {
      return this.requireList(await this.live().get<ClinOpsTimeSlot[]>('getDoctorsAvailability', {
        nom_medecin,
        date_prevue,
      }), 'getDoctorsAvailability', w => this.isRecord(w) && /^\d{2}:\d{2}:\d{2}$/.test(String(w.heure_debut)) &&
        /^\d{2}:\d{2}:\d{2}$/.test(String(w.heure_fin)));
    }

    const doctor = this.mockDoctors.find(
      d => d.doctorLabel.toLowerCase() === nom_medecin.toLowerCase(),
    );
    if (!doctor) {
      throw new BadRequestException('Aucun médecin trouvé avec ce nom');
    }

    // Per-doctor weekly schedule: no slots at all on a day this doctor
    // doesn't work, otherwise their own daily windows (which vary per
    // doctor — see doctors.mock.json). Discrete bookable times and
    // already-requested-slot exclusion are computed by the caller
    // (AvailabilityService), which expands these windows.
    const weekday = new Date(`${date_prevue}T00:00:00`).getDay();
    if (!doctor.workingDays.includes(weekday)) {
      return [];
    }
    return doctor.dailyWindows;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Available Doctors by Date — mirrors getAvailableDoctorsByDate
  // ═══════════════════════════════════════════════════════════════════════════

  async getAvailableDoctorsByDate(
    specialite_id: number,
    date: string,
    heure: string,
    excludeBookingRequestId?: string,
  ): Promise<ClinOpsDoctor[]> {
    if (!specialite_id || !date || !heure) {
      throw new BadRequestException('specialite_id, date et heure sont requis');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('Format de date invalide. Utilisez YYYY-MM-DD');
    }
    if (!/^\d{2}:\d{2}$/.test(heure)) {
      throw new BadRequestException("Format d'heure invalide. Utilisez HH:MM");
    }

    if (this.mode === 'live') {
      const available = this.requireList<ClinOpsDoctor>(await this.live().get<ClinOpsDoctor[]>('getAvailableDoctorsByDate', {
        specialite_id,
        date,
        heure,
      }), 'getAvailableDoctorsByDate', d => this.isRecord(d) && Number.isInteger(d.doctorId) && typeof d.doctorLabel === 'string');
      // ClinOps already excludes doctors blocked by *its own* appointments, but
      // it cannot know about a slot a patient just asked for here: an inbound
      // or campaign booking sits in the local review queue as PENDING until
      // staff confirm it, and only then does it become an RDV upstream. Without
      // this second filter two patients can be offered the same slot in the
      // window between request and confirmation.
      return this.excludeLocallyBookedDoctors(available, date, heure, excludeBookingRequestId);
    }

    const weekday = new Date(`${date}T00:00:00`).getDay();

    // Only doctors of this specialty who actually work this weekday, within
    // one of their daily windows at this exact hour, are candidates at all.
    const candidates = this.mockDoctors.filter(
      d =>
        d.specialite_id === specialite_id &&
        d.workingDays.includes(weekday) &&
        d.dailyWindows.some(w => heure >= w.heure_debut.slice(0, 5) && heure < w.heure_fin.slice(0, 5)),
    );
    if (candidates.length === 0) return [];

    // Same local review-queue exclusion the live path applies — see
    // excludeLocallyBookedDoctors() for why it is needed in both modes.
    return this.excludeLocallyBookedDoctors(
      candidates.map(({ doctorId, doctorLabel }) => ({ doctorId, doctorLabel })),
      date,
      heure,
      excludeBookingRequestId,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Create Appointment — mirrors createNewRDV
  // ═══════════════════════════════════════════════════════════════════════════

  async createNewRDV(
    request: ClinOpsCreateRDVRequest,
  ): Promise<{ success: boolean; message: string }> {
    if (!request.datePrevue || !request.motif || !request.medecinTraitant) {
      throw new BadRequestException('datePrevue, motif et medecinTraitant sont requis');
    }

    // The doc's format is ISO without a zone: 2025-12-15T10:00:00.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(request.datePrevue)) {
      throw new BadRequestException(
        'Format de date invalide (doit être ISO: 2025-12-15T10:00:00)',
      );
    }

    if (this.mode === 'live') {
      // Sent as-is: the four documented scenarios differ only by which optional
      // keys are present, so the scenario is chosen by the caller and this
      // method must not reshape it. Undefined keys are dropped, and the
      // server-side checks the doc describes (motif exists, medecinTraitant
      // exists, room/service available) stay upstream where they belong.
      return await this.live().postEnvelope<{ success: boolean; message: string }>(
        'createNewRDV',
        this.compact({ ...request } as Record<string, unknown>),
      );
    }

    if (!this.mockDoctors.some(d => d.doctorLabel.toLowerCase() === request.medecinTraitant.toLowerCase())) {
      throw new BadRequestException('Aucun médecin trouvé avec ce nom');
    }

    const hasPatientId      = request.patientId != null;
    const hasNumeroIdentite = !!request.numero_identite;
    const isNewPatient      =
      !!request.nom && !!request.prenom && !!request.telephone_prefix && !!request.telephone;

    if (!hasPatientId && !hasNumeroIdentite && !isNewPatient) {
      throw new BadRequestException(
        'Vous devez fournir patientId, numero_identite, ou les informations du nouveau patient (nom, prenom, telephone_prefix, telephone)',
      );
    }

    return { success: true, message: 'Rendez-vous créé avec succès' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Create Patient — mirrors createNewPatient
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Registers a patient upstream. No inbound or campaign flow calls this yet —
   * both create their patient implicitly through createNewRDV scenarios 3 and 4
   * — but the endpoint is documented, so live mode implements it rather than
   * leaving a hole for the first caller to fall into.
   */
  async createNewPatient(
    request: ClinOpsCreatePatientRequest,
  ): Promise<ClinOpsCreatePatientResponse> {
    const required: (keyof ClinOpsCreatePatientRequest)[] = [
      'nom', 'prenom', 'sexe', 'type_identite', 'telephone_prefix', 'telephone',
      'date_naissance', 'ville_naissance', 'ville', 'pays', 'adresse_principale',
    ];
    const missing = required.filter(field => !request[field]);
    if (missing.length > 0) {
      throw new BadRequestException(
        `Champs obligatoires manquants: ${missing.join(', ')}`,
      );
    }
    // Per the doc, numero_identite is required unless there is no ID document.
    if (request.type_identite !== "PAS D'IDENTITE" && !request.numero_identite) {
      throw new BadRequestException(
        "Champs obligatoires manquants: numero_identite (requis sauf si type_identite = \"PAS D'IDENTITE\")",
      );
    }

    if (this.mode === 'live') {
      return await this.live().postEnvelope<ClinOpsCreatePatientResponse>(
        'createNewPatient',
        this.compact({ ...request } as Record<string, unknown>),
      );
    }

    // Mock mode has no patient store to write through to, so the new patient is
    // appended to the in-memory fixture list: it is visible to searchPatients
    // for the rest of this process's life and gone on restart. Enough to
    // exercise a caller end to end without pretending mock data is persistent.
    if (this.mockPatients.some(p => p.cin && p.cin === request.numero_identite)) {
      throw new BadRequestException("Patient déjà existant avec ce numéro d'identité");
    }
    const patient_id = Math.max(0, ...this.mockPatients.map(p => p.patient_id)) + 1;
    this.mockPatients.push({
      patient_id,
      patient:                   `${request.prenom} ${request.nom}`,
      cin:                       request.numero_identite ?? null,
      sexe:                      request.sexe,
      age_years:                 this.ageFromBirthDate(request.date_naissance),
      ville:                     request.ville,
      pays:                      request.pays,
      date_derniere_admission:   new Date().toISOString(),
      prestation:                'Consultation',
      medecin_traitant:          '',
      solde_impaye:              '0.00',
      numeroTelephonePrincipale: `${request.telephone_prefix}${request.telephone}`,
      numeroTelephoneSecondaire: null,
    });
    return { success: true, message: 'Patient créé avec succès', patient_id };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Removes doctors already spoken for at this exact date/time by the local
   * review queue.
   *
   * Applies in both modes on purpose. A booking made through this bot lands in
   * `BookingRequest` as PENDING and only becomes a real RDV in ClinOps once
   * staff confirm it, so between those two moments ClinOps still believes the
   * doctor is free. Confirmed rows are checked too, to cover the window before
   * upstream state catches up.
   */
  private async excludeLocallyBookedDoctors(
    candidates: ClinOpsDoctor[],
    date: string,
    heure: string,
    excludeBookingRequestId?: string,
  ): Promise<ClinOpsDoctor[]> {
    if (candidates.length === 0) return [];

    const doctorNames = candidates.map(d => d.doctorLabel);
    const [conflictingRequests, conflictingAppointments] = await Promise.all([
      this.prisma.bookingRequest.findMany({
        where: {
          preferredDoctor: { in: doctorNames },
          requestedDate: date,
          requestedTime: heure,
          status: { in: [BookingRequestStatus.PENDING, BookingRequestStatus.CONFIRMED] },
          ...(excludeBookingRequestId && { id: { not: excludeBookingRequestId } }),
        },
        select: { preferredDoctor: true },
      }),
      this.prisma.appointment.findMany({
        where: {
          doctorName: { in: doctorNames },
          appointmentTime: heure,
          appointmentDate: new Date(`${date}T00:00:00`),
          status: { in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED] },
        },
        select: { doctorName: true },
      }),
    ]);

    const bookedNames = new Set([
      ...conflictingRequests.map(r => r.preferredDoctor),
      ...conflictingAppointments.map(a => a.doctorName),
    ]);

    return candidates.filter(d => !bookedNames.has(d.doctorLabel));
  }

  /**
   * Drops undefined/empty keys from a request body. The ClinOps doc lists many
   * optional fields and says nothing about how it treats explicit nulls, so
   * absent means absent.
   */
  private compact(body: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(body).filter(([, v]) => v !== undefined && v !== null && v !== ''),
    );
  }

  private isRecord(value: unknown): value is Record<string, any> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private requireList<T>(value: unknown, endpoint: string, valid: (item: any) => boolean): T[] {
    if (!Array.isArray(value) || !value.every(valid)) {
      throw new ServiceUnavailableException(`ClinOps ${endpoint} response does not match its documented shape`);
    }
    return value as T[];
  }

  private ageFromBirthDate(isoDate: string): number {
    const birth = new Date(`${isoDate}T00:00:00`);
    if (Number.isNaN(birth.getTime())) return 0;
    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    const monthDelta = now.getMonth() - birth.getMonth();
    if (monthDelta < 0 || (monthDelta === 0 && now.getDate() < birth.getDate())) age--;
    return age;
  }

  /**
   * Loads a JSON file from the `data/` subdirectory next to this service.
   * nest-cli.json has "assets": ["**\/*.json"] so files are copied to dist/ on build.
   * __dirname resolves correctly in both ts-node (src/) and nest build (dist/).
   */
  private loadJson<T>(filename: string): T {
    // Primary: dist/src/integrations/clinops/data/ (works in ts-node dev)
    let filePath = path.join(__dirname, 'data', filename);

    // Fallback: dist/integrations/clinops/data/ (nest-cli assets strips src/ prefix in Docker)
    if (!fs.existsSync(filePath)) {
      filePath = path.join(__dirname, '..', '..', '..', 'integrations', 'clinops', 'data', filename);
    }

    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
    } catch (err: any) {
      this.logger.error(`Failed to load mock data: ${filePath} — ${err.message}`);
      throw err;
    }
  }
}
