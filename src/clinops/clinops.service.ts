import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AppointmentStatus, BookingRequestStatus } from '@prisma/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ClinOpsPatient,
  ClinOpsPatientHistory,
  ClinOpsDoctor,
  ClinOpsSpecialty,
  ClinOpsTimeSlot,
  ClinOpsSearchFilters,
  ClinOpsCreateRDVRequest,
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
export class ClinOpsService {
  private readonly logger = new Logger(ClinOpsService.name);
  private readonly mode: 'mock' | 'live';

  // Mock data stores (loaded once at startup)
  private readonly mockPatients: ClinOpsPatient[];
  private readonly mockPatientHistories: Record<string, ClinOpsPatientHistory>;
  private readonly mockDoctors: ClinOpsDoctorMock[];
  private readonly mockSpecialties: ClinOpsSpecialty[];

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
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

  // ═══════════════════════════════════════════════════════════════════════════
  // Patient Search — mirrors searchPatientsInfos
  // ═══════════════════════════════════════════════════════════════════════════

  async searchPatients(filters: ClinOpsSearchFilters): Promise<ClinOpsPatient[]> {
    if (this.mode === 'live') {
      throw new NotImplementedException(
        'ClinOps live mode is not yet implemented. Set CLINOPS_MODE=mock.',
      );
    }

    const { cin_passeport, date_derniere_consultation, motif, numeroTelephone, OnlyVerifiedNumbers } = filters;

    // Per the doc, OnlyVerifiedNumbers is a modifier on the other filters, not
    // itself a qualifying filter — it must not satisfy this requirement alone.
    if (!cin_passeport && !motif && !numeroTelephone) {
      throw new BadRequestException(
        'Au moins un filtre requis (cin_passeport, motif, ou numeroTelephone)',
      );
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

  async getPatientHistory(identifier: string): Promise<ClinOpsPatientHistory> {
    if (!identifier?.trim()) {
      throw new BadRequestException(
        'Au moins un identifiant est requis (cin_passeport ou numeroTelephone)',
      );
    }

    if (this.mode === 'live') {
      throw new NotImplementedException(
        'ClinOps live mode is not yet implemented. Set CLINOPS_MODE=mock.',
      );
    }

    // Try CIN first (exact match)
    if (this.mockPatientHistories[identifier]) {
      return this.mockPatientHistories[identifier];
    }

    // Fallback: phone lookup — find patient by phone, load history by their CIN
    const normalizedPhone = identifier.replace(/\s+/g, '').toLowerCase();
    const patient = this.mockPatients.find(
      p =>
        p.numeroTelephonePrincipale?.replace(/\s+/g, '').toLowerCase() === normalizedPhone ||
        p.numeroTelephoneSecondaire?.replace(/\s+/g, '').toLowerCase() === normalizedPhone,
    );

    if (patient?.cin && this.mockPatientHistories[patient.cin]) {
      return this.mockPatientHistories[patient.cin];
    }

    throw new NotFoundException(
      `Aucun patient trouvé avec l'identifiant: ${identifier}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Specialties — mirrors getSpeciality
  // ═══════════════════════════════════════════════════════════════════════════

  async getSpecialities(): Promise<ClinOpsSpecialty[]> {
    if (this.mode === 'live') {
      throw new NotImplementedException(
        'ClinOps live mode is not yet implemented. Set CLINOPS_MODE=mock.',
      );
    }
    return this.mockSpecialties;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Doctors by Specialty — mirrors getDoctorsBySpeciality
  // ═══════════════════════════════════════════════════════════════════════════

  async getDoctorsBySpeciality(specialite_id: number): Promise<ClinOpsDoctor[]> {
    if (this.mode === 'live') {
      throw new NotImplementedException(
        'ClinOps live mode is not yet implemented. Set CLINOPS_MODE=mock.',
      );
    }
    if (specialite_id == null) {
      throw new BadRequestException('Le paramètre specialite_id est requis');
    }
    if (!Number.isInteger(specialite_id)) {
      throw new BadRequestException('specialite_id doit être un entier');
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
    if (this.mode === 'live') {
      throw new NotImplementedException(
        'ClinOps live mode is not yet implemented. Set CLINOPS_MODE=mock.',
      );
    }
    if (!nom_medecin || !date_prevue) {
      throw new BadRequestException('nom_medecin et date_prevue sont requis');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date_prevue)) {
      throw new BadRequestException('Format de date invalide (YYYY-MM-DD)');
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
  ): Promise<ClinOpsDoctor[]> {
    if (this.mode === 'live') {
      throw new NotImplementedException(
        'ClinOps live mode is not yet implemented. Set CLINOPS_MODE=mock.',
      );
    }
    if (!specialite_id || !date || !heure) {
      throw new BadRequestException('specialite_id, date et heure sont requis');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('Format de date invalide (YYYY-MM-DD)');
    }
    if (!/^\d{2}:\d{2}$/.test(heure)) {
      throw new BadRequestException("Format d'heure invalide (HH:MM)");
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

    // Exclude doctors already booked at this exact date/time — checked against
    // the local review-queue/appointment tables so a slot a patient just
    // requested (PENDING) or staff already confirmed (CONFIRMED) stops
    // appearing as available, per the doc's "non bloqués par...rendez-vous
    // existants" requirement.
    const doctorNames = candidates.map(d => d.doctorLabel);
    const [conflictingRequests, conflictingAppointments] = await Promise.all([
      this.prisma.bookingRequest.findMany({
        where: {
          preferredDoctor: { in: doctorNames },
          requestedDate: date,
          requestedTime: heure,
          status: { in: [BookingRequestStatus.PENDING, BookingRequestStatus.CONFIRMED] },
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

    return candidates
      .filter(d => !bookedNames.has(d.doctorLabel))
      .map(({ doctorId, doctorLabel }) => ({ doctorId, doctorLabel }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Create Appointment — mirrors createNewRDV
  // ═══════════════════════════════════════════════════════════════════════════

  async createNewRDV(
    request: ClinOpsCreateRDVRequest,
  ): Promise<{ success: boolean; message: string }> {
    if (this.mode === 'live') {
      throw new NotImplementedException(
        'ClinOps live mode is not yet implemented. Set CLINOPS_MODE=mock.',
      );
    }

    if (!request.datePrevue || !request.motif || !request.medecinTraitant) {
      throw new BadRequestException('datePrevue, motif et medecinTraitant sont requis');
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
  // Private helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Loads a JSON file from the `data/` subdirectory next to this service.
   * nest-cli.json has "assets": ["**\/*.json"] so files are copied to dist/ on build.
   * __dirname resolves correctly in both ts-node (src/) and nest build (dist/).
   */
  private loadJson<T>(filename: string): T {
    // Primary: dist/src/clinops/data/ (works in ts-node dev)
    let filePath = path.join(__dirname, 'data', filename);

    // Fallback: dist/clinops/data/ (nest-cli assets strips src/ prefix in Docker)
    if (!fs.existsSync(filePath)) {
      filePath = path.join(__dirname, '..', '..', 'clinops', 'data', filename);
    }

    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
    } catch (err: any) {
      this.logger.error(`Failed to load mock data: ${filePath} — ${err.message}`);
      throw err;
    }
  }
}