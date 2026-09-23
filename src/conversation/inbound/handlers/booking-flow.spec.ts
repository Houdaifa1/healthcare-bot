import { Language, BookingSource, AppointmentStatus } from '@prisma/client';
import { Session, SessionState } from '@platform/cache/sessions.service';
import { ReasonHandler } from './reason.handler';
import { ConfirmHandler } from './confirm.handler';

describe('inbound booking details', () => {
  const session = (): Session => ({ phone: '212600000001', state: SessionState.BOOKING_REASON,
    version: 2, updatedAt: Date.now(), data: { clinicId: 'clinic-1', language: Language.EN,
      languageConfirmed: true, patientName: 'Test Patient', specialtyId: 1,
      specialtyLabel: 'Cardiology', doctorName: 'DR Test', selectedDate: '2099-01-01',
      selectedTime: '10:00', reason: undefined as string | undefined } });

  it('collects a reason before allowing specialty selection', async () => {
    const whatsapp: any = { sendText: jest.fn() };
    const sessions: any = { save: jest.fn() };
    const specialty: any = { showSpecialtyList: jest.fn() };
    const nav: any = { handleMenuCommand: jest.fn().mockResolvedValue(false),
      handleUnresolvedSelection: jest.fn().mockResolvedValue(false) };
    const handler = new ReasonHandler(whatsapp, sessions, { getSafe: jest.fn() } as any,
      specialty, nav, { handle: jest.fn() } as any);
    const current = session();
    await handler.handle(current.phone, 'Follow-up consultation', current);
    expect(current.data.reason).toBe('Follow-up consultation');
    expect(current.state).toBe(SessionState.BOOKING_SPECIALTY);
    expect(sessions.save).toHaveBeenCalled();
    expect(specialty.showSpecialtyList).toHaveBeenCalled();
  });

  it('halts booking and alerts staff for an obvious emergency phrase', async () => {
    const whatsapp: any = { sendText: jest.fn() };
    const handoff: any = { handle: jest.fn() };
    const specialty: any = { showSpecialtyList: jest.fn() };
    const nav: any = { handleMenuCommand: jest.fn().mockResolvedValue(false) };
    const handler = new ReasonHandler(whatsapp, {} as any, {} as any, specialty, nav, handoff);
    const current = session();
    await handler.handle(current.phone, 'I have chest pain', current);
    expect(whatsapp.sendText).toHaveBeenCalledWith(current.phone, expect.stringContaining('emergency services'));
    expect(handoff.handle).toHaveBeenCalledWith(current.phone, 'I have chest pain', current);
    expect(specialty.showSpecialtyList).not.toHaveBeenCalled();
  });

  it('keeps ambiguous phone search results unassigned and saves the patient reason', async () => {
    const current = session();
    current.state = SessionState.BOOKING_CONFIRM;
    current.data.reason = 'Follow-up consultation';
    const whatsapp: any = { sendText: jest.fn() };
    const sessions: any = { reset: jest.fn() };
    const prisma: any = { bookingRequest: { create: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null) } };
    const matchingPatient = (id: number) => ({ patient_id: id,
      numeroTelephonePrincipale: '+212600000001', numeroTelephoneSecondaire: null });
    const clinops: any = { searchPatients: jest.fn().mockResolvedValue([
      matchingPatient(100), matchingPatient(101) ]) };
    const handler = new ConfirmHandler(whatsapp, sessions,
      { getSafe: jest.fn().mockResolvedValue('Request received') } as any,
      clinops, prisma, {} as any);

    await handler.handle(current.phone, 'confirm_yes', current);
    expect(prisma.bookingRequest.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      source: BookingSource.INBOUND, reason: 'Follow-up consultation',
      clinopsSpecialityId: 1, clinopsPatientId: null,
    }) });
    expect(prisma.bookingRequest.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        appointment: { is: { status: AppointmentStatus.CONFIRMED,
          appointmentDate: { gte: expect.any(Date) } } },
      }),
    }));
    expect(sessions.reset.mock.invocationCallOrder[0])
      .toBeLessThan(whatsapp.sendText.mock.invocationCallOrder[0]);
  });

  it('does not tell a patient that an existing appointment was cancelled', async () => {
    const current = session();
    current.state = SessionState.BOOKING_CONFIRM;
    const whatsapp: any = { sendText: jest.fn() };
    const sessions: any = { reset: jest.fn() };
    const templates: any = { getSafe: jest.fn((_clinic: string, _key: string, _vars: unknown,
      _language: Language, fallback: string) => fallback) };
    const handler = new ConfirmHandler(whatsapp, sessions, templates, {} as any,
      {} as any, {} as any);
    await handler.handle(current.phone, 'confirm_no', current);
    expect(whatsapp.sendText).toHaveBeenCalledWith(current.phone,
      'This booking request was stopped. Any existing appointment remains unchanged.');
  });

  it('links an inbound rebooking to an existing confirmed campaign appointment', async () => {
    const current = session();
    current.state = SessionState.BOOKING_CONFIRM;
    current.data.reason = 'Follow-up consultation';
    const prisma: any = { bookingRequest: {
      findFirst: jest.fn().mockResolvedValue({ id: 'previous-request' }),
      create: jest.fn(),
    } };
    const handler = new ConfirmHandler({ sendText: jest.fn() } as any,
      { reset: jest.fn() } as any, { getSafe: jest.fn().mockResolvedValue('Received') } as any,
      { searchPatients: jest.fn().mockResolvedValue([]) } as any, prisma, {} as any);
    await handler.handle(current.phone, 'confirm_yes', current);
    expect(prisma.bookingRequest.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ OR: expect.arrayContaining([
        { source: BookingSource.CAMPAIGN, campaignPatient: { is: {
          phone: current.phone, patientName: current.data.patientName,
        } } },
      ]) }),
    }));
    expect(prisma.bookingRequest.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      previousBookingRequestId: 'previous-request',
    }) });
  });
});
