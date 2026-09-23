import { ReminderService } from './reminder.service';

describe('reminder transport', () => {
  const patient = { id: 'patient-1', phone: '212600000001', patientName: 'Test Patient',
    visitDate: new Date('2026-01-01'), remindersSent: 0, reminderAttemptAt: null };
  let prisma: any;
  let whatsapp: any;
  let service: ReminderService;

  beforeEach(() => {
    prisma = { campaignPatient: { updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}) } };
    whatsapp = { sendTemplate: jest.fn().mockResolvedValue('wamid-reminder'), sendText: jest.fn() };
    const config: any = { get: (key: string) => key === 'campaign.reminderTemplateName'
      ? 'approved_reminder' : 'fr' };
    service = new ReminderService(prisma, { getCampaignSession: jest.fn().mockResolvedValue(null) } as any,
      whatsapp, config);
  });

  it('uses an approved template after reserving a reminder attempt', async () => {
    await (service as any).sendReminder(patient);
    expect(whatsapp.sendText).not.toHaveBeenCalled();
    expect(prisma.campaignPatient.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(whatsapp.sendTemplate.mock.invocationCallOrder[0]);
    expect(whatsapp.sendTemplate).toHaveBeenCalledWith('212600000001', 'approved_reminder', 'fr',
      expect.any(Array));
  });

  it('marks an uncertain Meta result for reconciliation', async () => {
    whatsapp.sendTemplate.mockRejectedValue(new Error('timeout'));
    await expect((service as any).sendReminder(patient)).rejects.toThrow('timeout');
    expect(prisma.campaignPatient.update).toHaveBeenCalledWith({ where: { id: 'patient-1' },
      data: { reminderAttemptState: 'RECONCILE' } });
  });
});
