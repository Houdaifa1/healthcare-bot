import { CampaignPatientStatus, CampaignStatus, Language } from '@prisma/client';
import { OutboundProcessor } from './outbound.processor';

describe('campaign send reservation', () => {
  const job = { data: { campaignPatientId: 'patient-1', campaignId: 'campaign-1', clinicId: 'clinic-1' } } as any;
  let prisma: any;
  let whatsapp: any;
  let processor: OutboundProcessor;

  beforeEach(() => {
    prisma = {
      campaignPatient: {
        findUnique: jest.fn().mockResolvedValue({ id: 'patient-1', clinicId: 'clinic-1',
          campaignId: 'campaign-1', status: CampaignPatientStatus.PENDING, phone: '212600000001',
          patientName: 'Test Patient', visitDate: new Date('2026-01-01'), patientSnapshot: {} }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
      campaign: { findUnique: jest.fn().mockResolvedValue({ id: 'campaign-1', status: CampaignStatus.RUNNING }) },
      clinic: { findUnique: jest.fn().mockResolvedValue({ id: 'clinic-1', defaultLanguage: Language.FR }) },
      contactSuppression: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    whatsapp = { sendTemplate: jest.fn().mockResolvedValue('wamid-test') };
    processor = new OutboundProcessor(prisma, {} as any, whatsapp, { get: jest.fn() } as any);
  });

  it('does not send when another worker owns the attempt', async () => {
    prisma.campaignPatient.updateMany.mockResolvedValue({ count: 0 });
    await processor.process(job);
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it('keeps the attempt reserved when Meta rejects or times out', async () => {
    whatsapp.sendTemplate.mockRejectedValue(new Error('timeout'));
    await expect(processor.process(job)).rejects.toThrow('timeout');
    expect(prisma.campaignPatient.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: CampaignPatientStatus.PENDING }),
      data: { status: CampaignPatientStatus.SENDING },
    }));
    expect(prisma.campaignPatient.update).not.toHaveBeenCalled();
  });

  it('does not send to a patient with a durable opt-out', async () => {
    prisma.contactSuppression.findUnique.mockResolvedValue({ id: 'suppression-1' });
    prisma.campaign.update = jest.fn();
    await processor.process(job);
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(prisma.campaignPatient.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: CampaignPatientStatus.OPTED_OUT }),
    }));
  });
});
