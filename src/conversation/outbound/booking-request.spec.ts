import { AppointmentStatus, BookingRequestStatus, CampaignPatientStatus, CampaignStatus, Language } from '@prisma/client';
import { ConversationService, bookingInput } from './conversation.service';

describe('follow-up rebooking', () => {
  it('rejects a model tool call missing a doctor or specialty', () => {
    expect(bookingInput({ reason: 'Consultation', preferredDateRange: 'Next week',
      preferredTimeRange: 'Morning' }))
      .toEqual({ missing: 'doctor' });
    expect(bookingInput({ reason: 'Consultation', preferredDoctor: 'DR Test',
      preferredDateRange: 'Next week', preferredTimeRange: 'Morning' }).value).toEqual({
      reason: 'Consultation', preferredDoctor: 'DR Test',
      preferredSpecialty: undefined, preferredDateRange: 'Next week', preferredTimeRange: 'Morning',
    });
  });

  it('leaves the existing confirmed appointment intact for staff reconciliation', async () => {
    const prisma: any = { bookingRequest: {
      findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
        id: 'old-request', status: BookingRequestStatus.CONFIRMED,
        appointmentId: 'old-appointment',
      }),
      create: jest.fn(), update: jest.fn(),
    }, appointment: { update: jest.fn() } };
    const service = new ConversationService(prisma, {} as any, {} as any, {} as any, {} as any);
    await (service as any).executeRequestBooking({
      reason: 'Follow-up', preferredDoctor: 'DR Test', preferredDateRange: 'Next week',
      preferredTimeRange: 'Morning',
    }, 'campaign-patient-1', 'clinic-1', 'I would like a new appointment');
    expect(prisma.bookingRequest.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      previousBookingRequestId: 'old-request', reason: 'Follow-up', preferredTimeRange: 'Morning',
    }) });
    expect(prisma.bookingRequest.findFirst).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ where: expect.objectContaining({
        appointment: { is: { status: AppointmentStatus.CONFIRMED,
          appointmentDate: { gte: expect.any(Date) } } },
      }) }));
    expect(prisma.appointment.update).not.toHaveBeenCalled();
    expect(prisma.bookingRequest.update).not.toHaveBeenCalled();
  });

  it('asks for missing time instead of falsely telling the patient a request was recorded', async () => {
    const session: any = { phone: '212600000001', campaignPatientId: 'campaign-patient-1',
      clinicId: 'clinic-1', language: Language.EN, messages: [], turnCount: 0,
      status: 'active', startedAt: Date.now(), lastActivityAt: Date.now() };
    const prisma: any = {
      campaignPatient: {
        findUnique: jest.fn().mockResolvedValue({ id: 'campaign-patient-1', campaignId: 'campaign-1',
          clinicId: 'clinic-1', phone: session.phone, patientName: 'Test Patient',
          visitDate: new Date('2026-01-01'), prestation: 'Consultation', medecinTraitant: 'DR Test',
          status: CampaignPatientStatus.REPLIED, patientSnapshot: {},
          campaign: { status: CampaignStatus.RUNNING, aiMaxTurns: 10 } }),
        update: jest.fn().mockResolvedValue({}),
      },
      clinic: { findUnique: jest.fn().mockResolvedValue({ id: 'clinic-1', name: 'Test Clinic',
        phone: '212600000099', aiMaxTurns: 10 }) },
      bookingRequest: { create: jest.fn() },
      aiUsage: { create: jest.fn() },
    };
    const sessions: any = { getCampaignSession: jest.fn().mockResolvedValue(session),
      saveCampaignSession: jest.fn(), getClient: jest.fn().mockReturnValue({
        lpush: jest.fn(), ltrim: jest.fn(),
      }) };
    const whatsapp: any = { sendText: jest.fn() };
    const ollama: any = { generate: jest.fn().mockResolvedValue({
      id: 'response-1', role: 'assistant', provider: 'ollama', model: 'fixture',
      stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 },
      content: [
        { type: 'text', text: 'Your booking request is recorded.' },
        { type: 'tool_use', id: 'tool-1', name: 'request_booking', input: {
          reason: 'Follow-up', preferredDoctor: 'DR Test', preferredDateRange: 'Next week',
        } },
      ],
    }) };
    const service = new ConversationService(prisma, sessions, whatsapp, {} as any, ollama);
    await service.handleReply(session.phone, 'I want a follow-up next week');
    expect(prisma.bookingRequest.create).not.toHaveBeenCalled();
    expect(whatsapp.sendText).toHaveBeenCalledWith(session.phone,
      'What time would you prefer? You can say any time if you are flexible.');
    expect(whatsapp.sendText).not.toHaveBeenCalledWith(session.phone,
      'Your booking request is recorded.');
  });
});
