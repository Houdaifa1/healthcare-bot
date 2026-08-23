import { Injectable } from '@nestjs/common';
import { MessageKey } from '@prisma/client';
import { Session } from '../sessions/sessions.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { PrismaService } from '../prisma/prisma.service';
import { BotMessageService } from './bot-message.service';

@Injectable()
export class WelcomeMenuService {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly botMessageService: BotMessageService,
    private readonly prisma: PrismaService,
  ) {}

  async show(phone: string, session: Session): Promise<void> {
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: session.data.clinicId },
      select: { name: true },
    });

    const message = await this.botMessageService.getSafe(
      session.data.clinicId,
      MessageKey.WELCOME,
      { clinicName: clinic?.name ?? '' },
      session.data.language,
      'Welcome! How can I help you?',
    );

    const btnBook = await this.botMessageService.getSafe(session.data.clinicId, MessageKey.BUTTON_BOOK_APP, {}, session.data.language, 'Book appointment');
    const btnFaq = await this.botMessageService.getSafe(session.data.clinicId, MessageKey.BUTTON_FAQ, {}, session.data.language, 'FAQ');
    const btnAgent = await this.botMessageService.getSafe(session.data.clinicId, MessageKey.BUTTON_AGENT, {}, session.data.language, 'Talk to agent');
    await this.whatsappService.sendButtons(phone, message, [
      { id: 'book_appointment', title: btnBook },
      { id: 'faq', title: btnFaq },
      { id: 'human_agent', title: btnAgent },
    ]);
  }
}
