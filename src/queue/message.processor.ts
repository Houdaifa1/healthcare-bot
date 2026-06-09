import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { SessionsService } from '../sessions/sessions.service';
import { PrismaService } from '../prisma/prisma.service';

export interface MessageJob {
  from: string;
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

    // Load clinic — always "main" for single-clinic setup
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: 'main' },
    });

    if (!clinic) {
      this.logger.error('Clinic not found — run seed first');
      return;
    }

    // Get or create session for this patient
    const session = await this.sessionsService.getOrCreate(
      from,
      clinic.id,
      clinic.defaultLanguage,
    );

    // Route to orchestrator
    try {
      await this.orchestratorService.handleMessage(from, text, session);
    } catch (error: any) {
      if (error?.response?.status === 400) {
        this.logger.error(`Permanent failure for ${from} — not retrying: ${error.message}`);
        return;
      }
      throw error; // Retry on other errors
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
    this.logger.error(`Job ${job.id} failed:`, error.message);
  }
}