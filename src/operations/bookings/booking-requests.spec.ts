import { BookingRequestStatus, BookingSource } from '@prisma/client';
import { BookingRequestsService } from './booking-requests.service';

describe('live booking confirmation', () => {
  const booking = {
    id: 'request-1', clinicId: 'clinic-1', source: BookingSource.INBOUND,
    status: BookingRequestStatus.PENDING, appointmentId: null, externalAttemptAt: null,
    clinopsPatientId: 1128, patientName: 'Test Patient', patientPhone: '212600000001',
    requestedDate: '2099-01-01', requestedTime: '10:00', preferredDoctor: 'DR Test',
    preferredSpecialty: 'Cardiologie', reason: 'Consultation',
  };
  const dto = { patientId: 1128, specialityId: 1, motif: 'Consultation',
    appointmentDate: '2099-01-01', appointmentTime: '10:00' };
  let prisma: any;
  let clinops: any;
  let service: BookingRequestsService;

  beforeEach(() => {
    prisma = {
      bookingRequest: {
        findFirst: jest.fn().mockResolvedValue(booking),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({ ...booking, status: BookingRequestStatus.CONFIRMED }),
      },
      appointment: { create: jest.fn().mockResolvedValue({ id: 'appointment-1' }) },
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    clinops = {
      isLiveMode: () => true,
      searchPatients: jest.fn().mockResolvedValue([{ patient_id: 1128, numeroTelephonePrincipale: '212600000001', numeroTelephoneSecondaire: null }]),
      getAvailableDoctorsByDate: jest.fn().mockResolvedValue([{ doctorId: 10, doctorLabel: 'DR Test' }]),
      createNewRDV: jest.fn().mockResolvedValue({ success: true, message: 'Rendez-vous créé' }),
    };
    service = new BookingRequestsService(prisma, { sendText: jest.fn() } as any, clinops);
  });

  it('confirms locally only after ClinOps accepts the documented request', async () => {
    await service.confirm('clinic-1', 'request-1', dto);
    expect(clinops.getAvailableDoctorsByDate).toHaveBeenCalledWith(1, '2099-01-01', '10:00', 'request-1');
    expect(clinops.createNewRDV).toHaveBeenCalledWith({ patientId: 1128,
      datePrevue: '2099-01-01T10:00:00', motif: 'Consultation', medecinTraitant: 'DR Test' });
    expect(clinops.createNewRDV.mock.invocationCallOrder[0]).toBeLessThan(prisma.appointment.create.mock.invocationCallOrder[0]);
    expect(prisma.bookingRequest.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: BookingRequestStatus.CONFIRMED }),
    }));
  });

  it('does not create a local confirmed appointment after an upstream failure', async () => {
    clinops.createNewRDV.mockRejectedValue(new Error('timeout; outcome unknown'));
    await expect(service.confirm('clinic-1', 'request-1', dto)).rejects.toThrow('outcome unknown');
    expect(prisma.appointment.create).not.toHaveBeenCalled();
    expect(prisma.bookingRequest.update).toHaveBeenCalledWith({ where: { id: 'request-1' },
      data: { externalAttemptState: 'RECONCILE' } });
  });

  it('refuses an unverified patient or a wrong patient ID before contacting ClinOps', async () => {
    await expect(service.confirm('clinic-1', 'request-1', { ...dto, patientId: 9999 })).rejects.toThrow('differs');
    await expect(service.confirm('clinic-1', 'request-1', { ...dto, motif: undefined })).rejects.toThrow('requires');
    expect(clinops.createNewRDV).not.toHaveBeenCalled();
  });

  it('rejects a patient ID whose ClinOps phone belongs to someone else', async () => {
    clinops.searchPatients.mockResolvedValue([{ patient_id: 1128,
      numeroTelephonePrincipale: '212600000099', numeroTelephoneSecondaire: null }]);
    await expect(service.confirm('clinic-1', 'request-1', dto)).rejects.toThrow('could not be verified');
    expect(clinops.createNewRDV).not.toHaveBeenCalled();
  });
});
