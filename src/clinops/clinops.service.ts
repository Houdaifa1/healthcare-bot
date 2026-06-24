import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

// Mock-only doctor shape — extends the API type with a specialty filter field
// that exists only in the JSON files and never leaves this service.
interface ClinOpsDoctorMock extends ClinOpsDoctor {
  specialite_id: number;
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
  private readonly mockAvailability: ClinOpsTimeSlot[];

  constructor(private readonly configService: ConfigService) {
    this.mode = this.configService.get<string>('clinops.mode') === 'live'
      ? 'live'
      : 'mock';

    this.logger.log(`ClinOpsService running in ${this.mode.toUpperCase()} mode`);

    if (this.mode === 'mock') {
      this.mockPatients        = this.loadJson<ClinOpsPatient[]>('patients.mock.json');
      this.mockPatientHistories = this.loadJson<Record<string, ClinOpsPatientHistory>>('patient-history.mock.json');
      this.mockDoctors         = this.loadJson<ClinOpsDoctorMock[]>('doctors.mock.json');
      this.mockSpecialties     = this.loadJson<ClinOpsSpecialty[]>('specialties.mock.json');
      this.mockAvailability    = this.loadJson<ClinOpsTimeSlot[]>('availability.mock.json');

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

    if (!cin_passeport && !motif && !numeroTelephone) {
      throw new BadRequestException(
        'Au moins un filtre est requis (cin_passeport, motif, ou numeroTelephone)',
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
    if (!specialite_id || !Number.isInteger(specialite_id)) {
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
    // Mock: return all slots regardless of doctor/date — real impl filters by schedule
    return this.mockAvailability;
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
    // Mock: return all doctors of the given specialty (ignore actual schedule)
    return this.mockDoctors
      .filter(d => d.specialite_id === specialite_id)
      .map(({ doctorId, doctorLabel }) => ({ doctorId, doctorLabel }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Create Appointment — mirrors createNewRDV
  // ═══════════════════════════════════════════════════════════════════════════

  async createNewRDV(
    request: ClinOpsCreateRDVRequest,
  ): Promise<{ success: boolean; message: string; patient_id?: number }> {
    if (this.mode === 'live') {
      throw new NotImplementedException(
        'ClinOps live mode is not yet implemented. Set CLINOPS_MODE=mock.',
      );
    }

    if (!request.datePrevue || !request.motif || !request.medecinTraitant) {
      throw new BadRequestException('datePrevue, motif et medecinTraitant sont requis');
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

    const patient_id = request.patientId ?? Math.floor(Math.random() * 9000) + 1000;
    return { success: true, message: 'Rendez-vous créé avec succès', patient_id };
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
    const filePath = path.join(__dirname, 'data', filename);
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
    } catch (err: any) {
      this.logger.error(`Failed to load mock data: ${filePath} — ${err.message}`);
      throw err;
    }
  }
}