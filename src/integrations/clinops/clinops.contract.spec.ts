import { ClinOpsHttpClient } from './clinops.http';
import { ClinOpsService } from './clinops.service';

const patient = {
  patient_id: 1128, patient: 'Test Patient', cin: '12345678', sexe: 'F', age_years: 40,
  ville: 'Tanger', pays: 'Maroc', date_derniere_admission: '2026-08-01T12:00:00+00:00',
  prestation: 'Consultation', medecin_traitant: 'DR Test', solde_impaye: '0.00',
  numeroTelephonePrincipale: '+212600000001', numeroTelephoneSecondaire: null,
};

describe('ClinOps documented contract', () => {
  const requests: Array<{ method: string; url: string; data?: Record<string, unknown>; authorization?: string }> = [];
  let service: ClinOpsService;

  beforeEach(() => {
    requests.length = 0;
    const config = {
      getOrThrow: (key: string) => ({
        'clinops.baseUrl': 'https://stage.clinops.app/new-backend/external_module',
        'clinops.username': 'test-user', 'clinops.password': 'test-password',
      })[key],
      get: (key: string, fallback?: unknown) => key === 'clinops.mode' ? 'live' : fallback,
    } as any;
    const client = new ClinOpsHttpClient(config);
    jest.spyOn((client as any).http, 'request').mockImplementation(async (req: any) => {
      requests.push({ method: String(req.method).toUpperCase(), url: req.url,
        data: req.data, authorization: req.headers?.Authorization });
      const data: Record<string, unknown> = {
        '/getAccesAutorisation': { success: true, token: 'test-token' },
        '/getSpeciality': { success: true, data: [{ specialityId: 1, specialityLabel: 'Cardiologie' }] },
        '/getDoctorsBySpeciality': { success: true, data: [{ doctorId: 10, doctorLabel: 'DR Test' }] },
        '/searchPatientsInfos': { success: true, data: [patient] },
        '/getPatientHistory': { success: true, data: { patient: 'Test Patient', solde_impaye: 0,
          admissions: [{ date_admission: '2026-08-01T12:00:00', motif_admission: 'Consultation',
            medecin_traitant: 'DR Test', actes_realises: [], produits_pharmaceutiques: [], avis_medicaux: [] }] } },
        '/getDoctorsAvailability': { success: true, data: [{ heure_debut: '08:00:00', heure_fin: '10:00:00' }] },
        '/getAvailableDoctorsByDate': { success: true, data: [{ doctorId: 10, doctorLabel: 'DR Test' }] },
        '/createNewPatient': { success: true, message: 'Patient créé', patient_id: 1129 },
        '/createNewRDV': { success: true, message: 'Rendez-vous créé' },
      };
      return { status: 200, data: data[req.url] };
    });
    const prisma = {
      bookingRequest: { findMany: jest.fn().mockResolvedValue([]) },
      appointment: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    service = new ClinOpsService(config, prisma, client);
  });

  it('uses only the nine documented routes, methods, fields and bearer authentication', async () => {
    await service.getSpecialities();
    await service.getDoctorsBySpeciality(1);
    await service.searchPatients({ cin_passeport: '12345678', OnlyVerifiedNumbers: true });
    await service.getPatientHistory({ cin_passeport: '12345678' });
    await service.getDoctorsAvailability('DR Test', '2026-12-15');
    await service.getAvailableDoctorsByDate(1, '2026-12-15', '10:00');
    await service.createNewPatient({ nom: 'TEST', prenom: 'Patient', sexe: 'F', type_identite: 'CIN',
      numero_identite: '12345678', telephone_prefix: '+212', telephone: '0600000001',
      date_naissance: '1986-01-01', ville_naissance: 'Tanger', ville: 'Tanger', pays: 'Maroc',
      adresse_principale: 'Test address' });
    await service.createNewRDV({ patientId: 1128, datePrevue: '2026-12-15T10:00:00',
      motif: 'Consultation', medecinTraitant: 'DR Test' });

    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'POST /getAccesAutorisation', 'GET /getSpeciality', 'GET /getDoctorsBySpeciality',
      'GET /searchPatientsInfos', 'GET /getPatientHistory', 'GET /getDoctorsAvailability',
      'GET /getAvailableDoctorsByDate', 'POST /createNewPatient', 'POST /createNewRDV',
    ]);
    expect(requests[0].data).toEqual({ username: 'test-user', password: 'test-password' });
    expect(requests[1].data).toBeUndefined();
    expect(requests[2].data).toEqual({ specialite_id: 1 });
    expect(requests[3].data).toEqual({ cin_passeport: '12345678', OnlyVerifiedNumbers: true });
    expect(requests[4].data).toEqual({ cin_passeport: '12345678' });
    expect(requests[5].data).toEqual({ nom_medecin: 'DR Test', date_prevue: '2026-12-15' });
    expect(requests[6].data).toEqual({ specialite_id: 1, date: '2026-12-15', heure: '10:00' });
    expect(requests[8].data).toEqual({ patientId: 1128, datePrevue: '2026-12-15T10:00:00',
      motif: 'Consultation', medecinTraitant: 'DR Test' });
    for (const request of requests.slice(1)) expect(request.authorization).toBe('Bearer test-token');
  });

  it('does not guess a numeric CIN is a phone number', async () => {
    await service.getPatientHistory({ cin_passeport: '12345678' });
    expect(requests[1].data).toEqual({ cin_passeport: '12345678' });
  });

  it('rejects malformed successful responses instead of treating them as empty results', async () => {
    jest.spyOn((service as any).http, 'get').mockResolvedValue(undefined);
    await expect(service.getSpecialities()).rejects.toThrow('documented shape');
  });
});
