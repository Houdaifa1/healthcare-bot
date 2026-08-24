import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import type { MessageJob } from '@platform/queue/queue.types';
import { OrchestratorService } from '@conversation/inbound/orchestrator.service';
import { SessionsService, SessionState } from '@platform/cache/sessions.service';
import { PrismaService } from '@platform/database/prisma.service';
import { ConversationService } from '@conversation/outbound/conversation.service';
import { HandoffService } from '@operations/handoff/handoff.service';
import { WhatsAppService } from '@integrations/whatsapp/whatsapp.service';

@Processor('messages')
export class MessageProcessor extends WorkerHost {
  private readonly logger = new Logger(MessageProcessor.name);

  constructor(
    private readonly orchestratorService:   OrchestratorService,
    private readonly sessionsService:       SessionsService,
    private readonly prisma:               PrismaService,
    private readonly conversationService:  ConversationService,
    private readonly handoffService:       HandoffService,
    private readonly whatsappService:      WhatsAppService,
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
      // A reply is always coming here, so show typing now — Ollama tool-calling
      // is the slow step this is meant to cover.
      await this.whatsappService.sendTypingIndicator(messageId);
      await this.conversationService.handleReply(from, text);
      return;
    }

    // ── 3b. Handoff routing — store patient message so staff can see it ────
    const isHandoff = await this.sessionsService.isHandoffCampaignSession(from);
    if (isHandoff) {
      this.logger.log(`Phone ${from} is in handoff/admin_handling — storing patient reply for staff`);

      // Record on the Handoff row first — that table is what the dashboard's
      // live-session view actually reads. recordPatientMessage() also mirrors
      // the transcript onto CampaignPatient for the campaign-side views.
      const recorded = await this.handoffService.recordPatientMessage(from, text);
      if (!recorded) {
        this.logger.warn(`No open Handoff row for ${from} despite handoff session status`);
      }

      // Keep the Redis campaign session transcript in sync too: staff replies
      // are mirrored there by HandoffService.sendMessage(), and it is the AI's
      // context if the conversation is ever handed back to the bot.
      const session = await this.sessionsService.getCampaignSession(from);
      if (session) {
        session.messages.push({ role: 'user', content: text, timestamp: Date.now() });
        session.lastActivityAt = Date.now();
        await this.sessionsService.saveCampaignSession(session);

        // Only needed when there was no Handoff row to mirror through above.
        if (!recorded) {
          await this.prisma.campaignPatient.update({
            where: { id: session.campaignPatientId },
            data: { messages: session.messages as any },
          }).catch(() => {
            this.logger.warn(`Failed to persist handoff message to DB for ${from}`);
          });
        }
      }

      this.logger.log(`Handoff message from ${from} stored — staff will see it`);
      return;
    }

    // ── 4. Load or create reactive session ────────────────────────────────
    const session = await this.sessionsService.getOrCreate(
      from,
      clinic.id,
      clinic.defaultLanguage,
    );

    // ── 4a. Inbound handoff gate ────────────────────────────────────────────
    // While an inbound handoff is OPEN/ADMIN_HANDLING, park the patient's
    // replies on the Handoff record (visible to staff on the dashboard)
    // instead of routing them to the orchestrator — mirrors how campaign
    // handoffs are gated via isHandoffCampaignSession above. The reactive
    // session only resets to IDLE once staff resolve the handoff from the
    // dashboard (or the patient types "menu", handled inside HandoffHandler).
    if (session.state === SessionState.AWAITING_HANDOFF) {
      const stillOpen = await this.handoffService.hasOpenHandoff(from);
      // Let "menu" fall through to HandoffHandler's own AWAITING_HANDOFF
      // branch so the patient can still explicitly escape back to the menu;
      // everything else is parked on the Handoff record for staff to see.
      if (stillOpen && text.trim().toLowerCase() !== 'menu') {
        await this.handoffService.recordPatientMessage(from, text);
        this.logger.log(`Phone ${from} is in an open inbound handoff — storing patient reply for staff`);
        return;
      }
      if (!stillOpen) {
        this.logger.log(`Reactive session for ${from} was AWAITING_HANDOFF but no open handoff remains — resetting to IDLE`);
        await this.sessionsService.reset(from);
        const freshSession = await this.sessionsService.getOrCreate(
          from,
          clinic.id,
          clinic.defaultLanguage,
        );
        Object.assign(session, freshSession);
      }
      // stillOpen && text === 'menu' falls through as-is — HandoffHandler's
      // own AWAITING_HANDOFF branch (below, via step 5) resets it to IDLE.
    }

    // ── 5. Route to reactive orchestrator ─────────────────────────────────
    // Every reactive state handler eventually replies (menu, booking steps,
    // AI-classified FAQ, etc.), so typing is safe to show unconditionally here.
    await this.whatsappService.sendTypingIndicator(messageId);
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