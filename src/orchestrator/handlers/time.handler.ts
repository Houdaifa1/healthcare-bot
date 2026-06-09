import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionsService } from '../../sessions/sessions.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { MessageKey } from '@prisma/client';
import { DoctorService } from '../../bot-content/doctor.service';
import { SpecialtyService } from '../../bot-content/specialty.service';

@Injectable()
export class TimeHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly botMessageService: BotMessageService,
    private readonly doctorService: DoctorService,
    private readonly specialtyService: SpecialtyService,
  ) {}

  async handle(phone: string, text: string, session: Session): Promise<void> {
    const time = text.replace('time_', '');
    session.data.selectedTime = time;
    session.state = SessionState.BOOKING_CONFIRM;
    await this.sessionsService.save(session);

    const doctorId = session.data.doctorId;
    const specialtyId = session.data.specialtyId;
    if (!doctorId || !specialtyId) {
      await this.whatsappService.sendText(phone, 'Missing booking information. Please start over.');
      return;
    }

    const doctor = await this.doctorService.findById(doctorId);
    if (!doctor) {
      await this.whatsappService.sendText(phone, 'Doctor not found. Please start over.');
      return;
    }

    const specialties = await this.specialtyService.findActive(
      session.data.clinicId,
      session.data.language,
    );
    const matchedSpecialty = specialties.find((s) => s.id === specialtyId);
    if (!matchedSpecialty) {
      await this.whatsappService.sendText(phone, 'Specialty not found. Please start over.');
      return;
    }

    const specialty = await this.specialtyService.findBySlug(
      session.data.clinicId,
      matchedSpecialty.slug,
      session.data.language,
    );
    if (!specialty) {
      await this.whatsappService.sendText(phone, 'Specialty not found. Please start over.');
      return;
    }

    const message = await this.botMessageService.get(
      session.data.clinicId,
      MessageKey.CONFIRM_BOOKING,
      {
        patientName: session.data.patientName || '',
        doctorName: doctor.name,
        date: session.data.selectedDate || '',
        time: session.data.selectedTime || '',
        specialty: specialty.label,
      },
      session.data.language,
    );

    await this.whatsappService.sendButtons(phone, message, [
      { id: 'confirm_yes', title: '✅ Confirmer' },
      { id: 'confirm_no', title: '❌ Annuler' },
    ]);
  }
}