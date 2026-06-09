import { Injectable } from '@nestjs/common';
import { Session, SessionState } from '../../sessions/sessions.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionsService } from '../../sessions/sessions.service';
import { SpecialtyService } from '../../bot-content/specialty.service';
import { DoctorService } from '../../bot-content/doctor.service';
import { BotMessageService } from '../../bot-content/bot-message.service';
import { MessageKey } from '@prisma/client';

@Injectable()
export class SpecialtyHandler {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionsService: SessionsService,
    private readonly specialtyService: SpecialtyService,
    private readonly doctorService: DoctorService,
    private readonly botMessageService: BotMessageService,
  ) {}

  async handle(phone: string, text: string, session: Session): Promise<void> {
    const slug = text.replace('specialty_', '');
    const specialty = await this.specialtyService.findBySlug(
      session.data.clinicId,
      slug,
      session.data.language,
    );

    if (!specialty) {
      // TODO: handle invalid specialty
      return;
    }

    session.data.specialtyId = specialty.id;
    session.state = SessionState.BOOKING_DOCTOR;
    await this.sessionsService.save(session);

    const doctors = await this.doctorService.findBySpecialty(
      session.data.clinicId,
      specialty.id,
    );

    const message = await this.botMessageService.get(
      session.data.clinicId,
      MessageKey.SELECT_DOCTOR,
      { specialty: specialty.label },
      session.data.language,
    );

    await this.whatsappService.sendInteractiveList(
      phone,
      message,
      'Doctors',
      'Select a doctor',
      [
        {
          title: 'Doctors',
          rows: doctors.map((d) => ({
            id: `doctor_${d.id}`,
            title: d.name,
          })),
        },
      ],
    );
  }
}