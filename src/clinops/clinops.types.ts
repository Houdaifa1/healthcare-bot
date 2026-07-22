/**
 * Exact shapes returned by the ClinOps external API.
 * Field names must never be renamed — they map 1-to-1 with the API response.
 * These types are shared between mock and live modes.
 */

// ── searchPatientsInfos response item ────────────────────────────────────────
export interface ClinOpsPatient {
  patient_id: number;
  patient: string; // full name e.g. "Hind BEN"
  cin: string | null;
  sexe: string; // "M" | "F"
  age_years: number;
  ville: string;
  pays: string;
  date_derniere_admission: string; // ISO datetime e.g. "2025-04-30T12:55:10.019303+00:00"
  prestation: string; // act/visit reason
  medecin_traitant: string;
  solde_impaye: string; // kept as string — matches API
  numeroTelephonePrincipale: string;
  numeroTelephoneSecondaire: string | null;
}

// ── getPatientHistory response ────────────────────────────────────────────────
export interface ClinOpsAdmission {
  date_admission: string; // ISO datetime
  motif_admission: string;
  medecin_traitant: string;
  actes_realises: string[];
  produits_pharmaceutiques: string[];
  avis_medicaux: string[];
}

export interface ClinOpsPatientHistory {
  patient: string;
  solde_impaye: number; // numeric in history response (API inconsistency vs searchPatients)
  admissions: ClinOpsAdmission[];
}

// ── getSpeciality response item ───────────────────────────────────────────────
export interface ClinOpsSpecialty {
  specialityId: number;
  specialityLabel: string;
}

// ── getDoctorsBySpeciality / getAvailableDoctorsByDate response item ──────────
// specialite_id is NOT in the real API response — it must not appear on this type.
// Mock data that needs to filter by specialty stores it separately in the mock file.
export interface ClinOpsDoctor {
  doctorId: number;
  doctorLabel: string;
}

// ── getDoctorsAvailability response item ──────────────────────────────────────
export interface ClinOpsTimeSlot {
  heure_debut: string; // "08:00:00"
  heure_fin: string; // "10:00:00"
}

// ── searchPatients filter params ──────────────────────────────────────────────
export interface ClinOpsSearchFilters {
  cin_passeport?: string;
  date_derniere_consultation?: string; // YYYY-MM-DD
  motif?: string;
  numeroTelephone?: string; // e.g. "+212666666666"
  OnlyVerifiedNumbers?: boolean;
}

// ── createNewRDV request body (supports all 4 API scenarios) ─────────────────
export interface ClinOpsCreateRDVRequest {
  // Scenario 1: existing patient by ID
  patientId?: number;
  // Scenario 2 or 4: existing or new patient by CIN/passport
  numero_identite?: string;
  // Scenarios 3 & 4: new patient fields
  nom?: string;
  prenom?: string;
  sexe?: string; // "M" | "F"
  type_identite?: string; // "CIN" | "PASSEPORT" | "CARTE SEJOUR" | "PAS D'IDENTITE"
  telephone_prefix?: string; // e.g. "+212"
  telephone?: string;
  date_naissance?: string; // YYYY-MM-DD
  pays?: string;
  // Always required
  datePrevue: string; // ISO datetime "2025-12-15T10:00:00"
  motif: string;
  medecinTraitant: string;
}
