import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MessageProcessor } from './message.processor';
import { QUEUES } from './queue.constants';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { BotContentModule } from '../bot-content/bot-content.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUES.MESSAGES }),
    OrchestratorModule,
    WhatsAppModule,
    BotContentModule,
  ],
  providers: [MessageProcessor],
  exports: [BullModule],
})
export class QueueModule {}