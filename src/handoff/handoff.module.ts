import { Module } from '@nestjs/common';
import { HandoffService } from './handoff.service';
import { HandoffController } from './handoff.controller';
import { SessionsModule } from '../sessions/sessions.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { PrismaModule } from '../prisma/prisma.module';
import { HandoffEventsService } from './handoff.events';

@Module({
  imports: [SessionsModule, WhatsAppModule, PrismaModule],
  controllers: [HandoffController],
  providers: [HandoffService, HandoffEventsService],
  exports: [HandoffService, HandoffEventsService],
})
export class HandoffModule {}