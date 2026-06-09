import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MessageProcessor } from './message.processor';
import { QUEUES } from './queue.constants';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUES.MESSAGES }),
    OrchestratorModule,
  ],
  providers: [MessageProcessor],
  exports: [BullModule],
})
export class QueueModule {}