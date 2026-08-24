import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QUEUES } from './queue.constants';

// Queue infrastructure only — the global BullMQ/Redis connection and the queue
// registrations. Deliberately holds no processors: the consumers live with the
// domains they serve (conversation/inbound, conversation/outbound), so this
// module imports nothing from higher layers and can be imported by any of them.
//
// Registering both queues here and exporting BullModule makes this the single
// registration point. Previously QUEUES.MESSAGES was registered twice (in
// WhatsAppModule and QueueModule), which could not be deduplicated while the
// only module exporting it also imported WhatsAppModule — that would have been
// a dependency cycle.
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const redisUrl = configService.get<string>('redis.url');
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
    BullModule.registerQueue({ name: QUEUES.CAMPAIGN_OUTBOUND }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
