import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { SessionsService } from '../sessions/sessions.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationService } from '../campaign/conversation.service';

export interface MessageJob {
  from:      string;
  name:      string;
  text:      string;
  messageId: string;
  timestamp: string;
}

@Processor('messages')
export class MessageProcessor extends WorkerHost {
  private readonly logger = new Logger(MessageProcessor.name);

  constructor(
    private readonly orchestratorService:   OrchestratorService,
    private readonly sessionsService:       SessionsService,
    private readonly prisma:               PrismaService,
    private readonly conversationService:  ConversationService,
  ) {
    super();
  }

  async process(job: Job<MessageJob>): Promise<void> {
    const { from, name, text, messageId } = job.data;
    this.logger.log(`Processing message from ${name} (+${from}): "${text}"`);

    // ── 1. Message deduplication ───────────────────────────────────────────
    if (messageId) {
      const isNew = await this.sessionsService.markMessageProcessed(messageId);
      if (!isNew) {
        this.logger.warn(`Duplicate messageId ${messageId} — skipping`);
        return;
      }
    }

    // ── 2. Load clinic dynamically ─────────────────────────────────────────
    const clinic = await this.prisma.clinic.findFirst();
    if (!clinic) {
      this.logger.error('No clinic record found — run `npm run seed` first');
      return;
    }

    // ── 3. Campaign routing ────────────────────────────────────────────────
    const hasCampaign = await this.sessionsService.hasActiveCampaignSession(from);
    if (hasCampaign) {
      this.logger.log(`Phone ${from} has active campaign session — routing to ConversationService`);
      await this.conversationService.handleReply(from, text);
      return;
    }

    const isHandoff = await this.sessionsService.isHandoffCampaignSession(from);
    if (isHandoff) {
      this.logger.log(`Phone ${from} is in handoff/admin_handling — dropping message, staff is handling`);
      return;
    }

    // ── 4. Load or create reactive session ────────────────────────────────
    const { session } = await this.sessionsService.getOrCreate(
      from,
      clinic.id,
      clinic.defaultLanguage,
      clinic.timezone,
    );

    // ── 5. Route to reactive orchestrator ─────────────────────────────────
    try {
      await this.orchestratorService.handleMessage(from, text, session);
    } catch (error: any) {
      const message: string    = error?.message ?? '';
      const statusCode: number =
        error?.output?.statusCode ??
        error?.response?.status ??
        error?.response?.statusCode ??
        0;

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

      if (statusCode >= 400 && statusCode < 500) {
        this.logger.error(
          `Permanent failure for ${from} (HTTP ${statusCode}): ${message}`,
        );
        return;
      }

      throw error;
    }
  }

  @OnWorkerEvent('ready')
  onReady(): void {
    this.logger.log('Message worker ready');
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error('Worker error:', error.message);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error): void {
    this.logger.error(`Job ${job.id} failed after all retries: ${error.message}`);
  }
}