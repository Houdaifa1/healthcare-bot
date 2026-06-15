import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import Redis from 'ioredis';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { SessionsService } from '../sessions/sessions.service';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { BotMessageService } from '../bot-content/bot-message.service';

export interface MessageJob {
  from:      string; // E.164 phone number without '+', e.g. "212644645877"
  name:      string; // WhatsApp display name
  text:      string; // Extracted message text or button/list ID
  messageId: string;
  timestamp: string;
}

@Processor('messages')
export class MessageProcessor extends WorkerHost {
  private readonly logger = new Logger(MessageProcessor.name);
  private readonly redis: Redis;

  constructor(
    private readonly orchestratorService: OrchestratorService,
    private readonly sessionsService: SessionsService,
    private readonly prisma: PrismaService,
    private readonly whatsappService: WhatsAppService,
    private readonly botMessageService: BotMessageService,
  ) {
    super();
    // Create a dedicated Redis connection for dedup
    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const isUpstash = redisUrl.includes('upstash.io');
    this.redis = new Redis(redisUrl, {
      tls: isUpstash ? {} : undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }

  async process(job: Job<MessageJob>): Promise<void> {
    const { from, name, text, messageId } = job.data;
    this.logger.log(`Processing message from ${name} (+${from}): "${text}"`);

    // ── Message deduplication (BUG 17) ─────────────────────────────────────
    // Meta can deliver the same messageId twice on timeout.
    // Check and set with 5-minute TTL.
    if (messageId) {
      const dedupKey = `processed:${messageId}`;
      const isNew = await this.redis.set(dedupKey, '1', 'EX', 300, 'NX');
      if (!isNew) {
        this.logger.warn(`Duplicate messageId ${messageId} — skipping`);
        return;
      }
    }

    // ── Load clinic ────────────────────────────────────────────────────────
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: 'main' },
    });

    if (!clinic) {
      this.logger.error('Clinic "main" not found — run `npm run seed` first');
      return;
    }

    // ── Load or create session ─────────────────────────────────────────────
    const { session, isNew } = await this.sessionsService.getOrCreate(
      from,
      clinic.id,
      clinic.defaultLanguage,
      clinic.timezone,
    );

    // ── Route to orchestrator ──────────────────────────────────────────────
    try {
      await this.orchestratorService.handleMessage(from, text, session);
    } catch (error: any) {
      const message: string    = error?.message ?? '';
      const statusCode: number =
        error?.output?.statusCode ??
        error?.response?.status ??
        error?.response?.statusCode ??
        0;

      // Meta API transient errors (5xx) or our own send timeout — retry
      if (
        message.includes('not connected after') ||
        message.includes('Meta API error 5') ||
        statusCode === 428 ||
        statusCode >= 500
      ) {
        this.logger.warn(
          `Transient error for ${from} — BullMQ will retry: ${message}`,
        );
        throw error;
      }

      // 4xx (except 428) are caller mistakes — do not retry
      if (statusCode >= 400 && statusCode < 500) {
        this.logger.error(
          `Permanent failure for ${from} (HTTP ${statusCode}): ${message}`,
        );
        return;
      }

      // Unknown errors — rethrow for retry
      throw error;
    }
  }

  @OnWorkerEvent('ready')
  onReady() {
    this.logger.log('Message worker ready');
  }

  @OnWorkerEvent('error')
  onError(error: Error) {
    this.logger.error('Worker error:', error.message);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(`Job ${job.id} failed after all retries: ${error.message}`);
  }
}