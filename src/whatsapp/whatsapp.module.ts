import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { WebhookController } from './webhook.controller';
import { WhatsAppService } from './whatsapp.service';
import { QUEUES } from '../queue/queue.constants';

@Module({
  imports: [
    // Register the queue connection directly here
    // instead of importing the full QueueModule which creates a circular dep
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const redisUrl = configService.get<string>('REDIS_URL');
        const isUpstash = redisUrl?.includes('upstash.io');
        return {
          connection: {
            url: redisUrl,
            tls: isUpstash ? {} : undefined,
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
          },
        };
      },
      inject: [ConfigService],
    }),
    BullModule.registerQueue({ name: QUEUES.MESSAGES }),
  ],
  controllers: [WebhookController],
  providers: [WhatsAppService],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}