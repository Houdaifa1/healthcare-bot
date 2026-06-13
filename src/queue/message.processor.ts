import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { SessionsService } from '../sessions/sessions.service';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { BotMessageService } from '../bot-content/bot-message.service';
import { FlowEngineService } from '../flows/flow-engine.service';

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

  constructor(
    private readonly orchestratorService: OrchestratorService,
    private readonly sessionsService: SessionsService,
    private readonly prisma: PrismaService,
    private readonly whatsappService: WhatsAppService,
    private readonly botMessageService: BotMessageService,
    private readonly flowEngineService: FlowEngineService,
  ) {
    super();
  }

  async process(job: Job<MessageJob>): Promise<void> {
    const { from, name, text } = job.data;
    this.logger.log(`Processing message from ${name} (+${from}): "${text}"`);

    // ── Load clinic ────────────────────────────────────────────────────────
    // Single-clinic setup — id is always 'main' (set during seed).
    // If you go multi-clinic, derive clinicId from the incoming phone number id.
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: 'main' },
    });

    if (!clinic) {
      this.logger.error('Clinic "main" not found — run `npm run seed` first');
      // Permanent failure — no point retrying until the DB is seeded
      return;
    }

    // ── Load or create session ─────────────────────────────────────────────
    // `from` is a clean E.164 number — safe to use directly as the session key.
    const { session, isNew } = await this.sessionsService.getOrCreate(
      from,
      clinic.id,
      clinic.defaultLanguage,
    );

    // ── Session expiry notification ──────────────────────────────────────
    // `isNew` is true on first-time visits OR when Redis TTL expires (30 min).
    // Since we can't distinguish first visits from expired sessions,
    // SESSION_EXPIRED notification is omitted here.
    // The fresh session starts cleanly in IDLE state which is fine UX.
    // If a more sophisticated expiry notification is needed later, store
    // a separate "last phone number seen" set in Redis.
    // ── Try flow engine first (if active flow exists) ────────────────────────
    const flowHandled = await this.flowEngineService.processMessage(
      from,
      text,
      session,
    );

    if (flowHandled) {
      this.logger.log(`Flow engine handled message from ${from}`);
      return;
    }

    // ── Fallback to legacy orchestrator ──────────────────────────────────────
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