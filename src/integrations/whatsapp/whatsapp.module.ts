import { Module } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppController } from './whatsapp.controller';
import { QueueModule } from '@platform/queue/queue.module';

// QUEUES.MESSAGES is no longer registered here — it comes from platform/queue,
// the single registration point. WhatsAppService is the producer on that queue;
// the consumer lives in conversation/inbound.
@Module({
  imports: [QueueModule],
  controllers: [WhatsAppController],
  providers: [WhatsAppService],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
