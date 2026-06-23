// Exact shapes returned by the ClinOps API — do not rename fields

export interface ClinOpsPatient {
  patient_id:                  number;
  patient:                     string;   // full name "Hind BEN"
  cin:                         string | null;
  sexe:                        string;   // "M" | "F"
  age_years:                   number;
  ville:                       string;
  pays:                        string;
  date_derniere_admission:     string;   // ISO datetime
  prestation:                  string;
  medecin_traitant:            string;
  solde_impaye:                string;
  numeroTelephonePrincipale:   string;
  numeroTelephoneSecondaire:   string | null;
}

export interface ClinOpsAdmission {
  date_admission:              string;
  motif_admission:             string;
  medecin_traitant:            string;
  actes_realises:              string[];
  produits_pharmaceutiques:    string[];
  avis_medicaux:               string[];
}

export interface ClinOpsPatientHistory {
  patient:                     string;
  solde_impaye:                number;
  admissions:                  ClinOpsAdmission[];
}

export interface ClinOpsDoctor {
  doctorId:                    number;
  doctorLabel:                 string;
  specialite_id:               number;  // added in mock only for filtering
}

export interface ClinOpsSpecialty {
  specialityId:                number;
  specialityLabel:             string;
}

export interface ClinOpsTimeSlot {
  heure_debut:                 string;  // "08:00:00"
  heure_fin:                   string;  // "10:00:00"
}

export interface ClinOpsSearchFilters {
  cin_passeport?:              string;
  date_derniere_consultation?: string;  // YYYY-MM-DD
  motif?:                      string;
  numeroTelephone?:            string;
  OnlyVerifiedNumbers?:        boolean;
}