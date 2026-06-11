import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { SessionsService } from '../sessions/sessions.service';
import { PrismaService } from '../prisma/prisma.service';

export interface MessageJob {
  from: string;   // full remoteJid, e.g. 123456789@s.whatsapp.net or @lid
  name: string;
  text: string;
  messageId: string;
  timestamp: string;
}

@Processor('messages')
export class MessageProcessor extends WorkerHost {
  private readonly logger = new Logger(MessageProcessor.name);

  constructor(
    private readonly orchestratorService: OrchestratorService,
    private readonly sessionsService: SessionsService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async process(job: Job<MessageJob>): Promise<void> {
    const { from, name, text } = job.data;
    this.logger.log(`Processing message from ${name} (${from}): ${text}`);

    const clinic = await this.prisma.clinic.findUnique({
      where: { id: 'main' },
    });

    if (!clinic) {
      // Permanent failure — no point retrying without seeded data
      this.logger.error('Clinic not found — run seed first');
      return;
    }

    const session = await this.sessionsService.getOrCreate(
      from,
      clinic.id,
      clinic.defaultLanguage,
    );

    try {
      await this.orchestratorService.handleMessage(from, text, session);
    } catch (error: any) {
      const message: string = error?.message ?? '';
      const statusCode: number =
        error?.output?.statusCode ??
        error?.response?.status ??
        error?.response?.statusCode ??
        0;

      // 428 "Connection Closed" and our own timeout error are transient —
      // throw so BullMQ retries with exponential backoff.
      if (
        message.includes('Connection Closed') ||
        message.includes('not connected after') ||
        statusCode === 428
      ) {
        this.logger.warn(
          `Transient WhatsApp error for ${from} — job will be retried: ${message}`,
        );
        throw error;
      }

      // 400-range errors other than 428 are caller mistakes — don't retry.
      if (statusCode >= 400 && statusCode < 500) {
        this.logger.error(
          `Permanent failure for ${from} (HTTP ${statusCode}) — not retrying: ${message}`,
        );
        return;
      }

      // Everything else (500s, unknown) — rethrow so BullMQ retries.
      throw error;
    }
  }

  @OnWorkerEvent('ready')
  onReady() {
    this.logger.log('Message worker is ready and connected to Redis');
  }

  @OnWorkerEvent('error')
  onError(error: Error) {
    this.logger.error('Worker error:', error.message);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(`Job ${job.id} failed:\n${error.message}`);
  }
}