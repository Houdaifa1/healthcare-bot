import { CampaignPatientStatus, CampaignStatus } from '@prisma/client';
import { CampaignService } from './campaign.service';

describe('campaign dispatch after commit', () => {
  it('does not include partial ClinOps phone-search matches in targeted campaigns', async () => {
    const prisma: any = { contactSuppression: { findMany: jest.fn().mockResolvedValue([]) } };
    const clinops: any = { searchPatients: jest.fn().mockResolvedValue([
      { patient_id: 1, numeroTelephonePrincipale: '+212600000001', numeroTelephoneSecondaire: null },
      { patient_id: 2, numeroTelephonePrincipale: '+2126000000019', numeroTelephoneSecondaire: null },
    ]) };
    const service = new CampaignService(prisma, clinops, {} as any, {} as any, {} as any, {} as any);
    const patients = await (service as any).matchPatients('clinic-1', {
      filterPhoneNumbers: ['+212600000001'], onlyVerifiedNumbers: true,
    });
    expect(patients.map((patient: any) => patient.patient_id)).toEqual([1]);
  });

  it('queues a durable pending patient only after the database transaction commits', async () => {
    let inTransaction = false;
    const campaign = { id: 'campaign-1', clinicId: 'clinic-1', name: 'Test',
      status: CampaignStatus.DRAFT, delayHours: 0, launchedAt: new Date() };
    const prisma: any = {
      clinic: { findUnique: jest.fn().mockResolvedValue({ id: 'clinic-1', campaignDelayHours: 0 }) },
      campaign: { findFirst: jest.fn().mockResolvedValue({ ...campaign, status: CampaignStatus.RUNNING }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      campaignPatient: { create: jest.fn().mockResolvedValue({ id: 'patient-1' }),
        findMany: jest.fn().mockResolvedValue([{ id: 'patient-1' }]) },
    };
    prisma.$transaction = jest.fn(async (fn: any) => {
      inTransaction = true;
      try { return await fn(prisma); } finally { inTransaction = false; }
    });
    const queue: any = { getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockImplementation(() => {
        expect(inTransaction).toBe(false);
      }) };
    const clinops: any = { getPatientHistory: jest.fn().mockResolvedValue(null) };
    const service = new CampaignService(prisma, clinops, {} as any, {} as any, {} as any, queue);
    jest.spyOn(service as any, 'fetchPatientsFromClinOps').mockResolvedValue([{
      patient_id: 1, patient: 'Test Patient', cin: '12345678', sexe: 'F', age_years: 40,
      ville: 'Tanger', pays: 'Maroc', numeroTelephonePrincipale: '212600000001',
      numeroTelephoneSecondaire: null, solde_impaye: '0', date_derniere_admission: '2026-01-01',
      prestation: 'Consultation', medecin_traitant: 'DR Test',
    }]);

    await (service as any).executeLaunch(campaign);

    expect(prisma.campaign.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: [CampaignStatus.DRAFT, CampaignStatus.SCHEDULED] } }),
    }));
    expect(prisma.campaignPatient.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { campaignId: 'campaign-1', status: CampaignPatientStatus.PENDING },
    }));
    expect(queue.add).toHaveBeenCalledWith(expect.any(String), expect.any(Object),
      expect.objectContaining({ jobId: 'campaign-patient-1' }));
  });
});
