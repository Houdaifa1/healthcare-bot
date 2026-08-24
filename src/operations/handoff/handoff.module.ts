import { Module } from '@nestjs/common';
import { HandoffService } from './handoff.service';
import { HandoffController } from './handoff.controller';
import { SessionsModule } from '@platform/cache/sessions.module';
import { WhatsAppModule } from '@integrations/whatsapp/whatsapp.module';
import { PrismaModule } from '@platform/database/prisma.module';

@Module({
  imports: [SessionsModule, WhatsAppModule, PrismaModule],
  controllers: [HandoffController],
  providers: [HandoffService],
  exports: [HandoffService],
})
export class HandoffModule {}