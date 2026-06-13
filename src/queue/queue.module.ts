import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MessageProcessor } from './message.processor';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { SessionsModule } from '../sessions/sessions.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { BotContentModule } from '../bot-content/bot-content.module';
import { FlowsModule } from '../flows/flows.module';
import { QUEUES } from './queue.constants';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUES.MESSAGES }),
    WhatsAppModule,
    SessionsModule,
    OrchestratorModule,
    BotContentModule,
    FlowsModule,
  ],
  providers: [MessageProcessor],
})
export class QueueModule {}