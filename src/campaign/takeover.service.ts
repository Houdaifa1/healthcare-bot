import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { CampaignPatientStatus } from '@prisma/client';

export interface ActiveHandover {
  campaignPatientId: string;
  campaignId:        string;
  phone:             string;
  patientName:       string;
  clinicId:          string;
  takenOverAt:       number;
  lastActivityAt:    number;
  turnCount:         number;
  language:          string | null;
}

@Injectable()
export class TakeoverService {
  private readonly logger = new Logger(TakeoverService.name);

  constructor(
    private readonly prisma:           PrismaService,
    private readonly sessionsService:  SessionsService,
    private readonly whatsappService:  WhatsAppService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // TAKE OVER — staff claims the conversation, bot goes silent
  // ═══════════════════════════════════════════════════════════════════════════

  async takeOver(clinicId: string, phone: string): Promise<{ ok: true }> {
    this.logger.log(`takeOver — clinicId=${clinicId} phone=${phone}`);

    // ── Verify the patient exists and belongs to this clinic ───────────────
    const campaignPatient = await this.prisma.campaignPatient.findFirst({
      where: { phone, clinicId },
      orderBy: { createdAt: 'desc' }, // most recent campaign patient for this phone
    });

    if (!campaignPatient) {
      throw new NotFoundException(
        `No campaign patient found for phone ${phone} in this clinic`,
      );
    }

    // ── Load the Redis session ─────────────────────────────────────────────
    const session = await this.sessionsService.getCampaignSession(phone);

    if (!session) {
      throw new BadRequestException(
        `No active campaign session found for ${phone} — patient may have already completed`,
      );
    }

    if (session.status === 'completed' || session.status === 'handed_off') {
      throw new BadRequestException(
        `Session for ${phone} is already ${session.status} — cannot take over`,
      );
    }

    if (session.status === 'admin_handling') {
      // Idempotent — already taken over, return ok
      this.logger.warn(`Session for ${phone} is already in admin_handling — idempotent return`);
      return { ok: true };
    }

    // ── Set session status to admin_handling ───────────────────────────────
    // hasActiveCampaignSession() checks for 'awaiting_reply' | 'active' only,
    // so the bot will now be silent for this phone.
    session.status = 'admin_handling';
    await this.sessionsService.saveCampaignSession(session);

    this.logger.log(
      `Staff takeover active for ${phone} — bot silenced for patient ${campaignPatient.id}`,
    );

    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SEND STAFF MESSAGE — staff reply sent to patient via WhatsApp
  // ═══════════════════════════════════════════════════════════════════════════

  async sendStaffMessage(
    clinicId: string,
    phone:    string,
    message:  string,
  ): Promise<{ ok: true }> {
    this.logger.log(`sendStaffMessage — clinicId=${clinicId} phone=${phone}`);

    if (!message?.trim()) {
      throw new BadRequestException('Message body cannot be empty');
    }

    // ── Verify session is in admin_handling ────────────────────────────────
    const session = await this.sessionsService.getCampaignSession(phone);

    if (!session) {
      throw new BadRequestException(
        `No campaign session found for ${phone}`,
      );
    }

    if (session.status !== 'admin_handling') {
      throw new BadRequestException(
        `Session for ${phone} is in status "${session.status}" — ` +
        `take over the conversation first before sending messages`,
      );
    }

    // ── Verify clinic ownership ────────────────────────────────────────────
    if (session.clinicId !== clinicId) {
      throw new BadRequestException(
        `Session for ${phone} does not belong to clinic ${clinicId}`,
      );
    }

    // ── Send via WhatsApp ──────────────────────────────────────────────────
    await this.whatsappService.sendText(phone, message.trim());

    // ── Append staff message to session history ────────────────────────────
    // Role is 'assistant' — from the patient's perspective, this is the clinic
    // responding. Keeps the message thread coherent if bot resumes later.
    session.messages.push({
      role:      'assistant',
      content:   message.trim(),
      timestamp: Date.now(),
    });

    await this.sessionsService.saveCampaignSession(session);

    // ── Persist to DB so the dashboard drawer shows it immediately ─────────
    const patient = await this.prisma.campaignPatient.findUnique({
      where:  { id: session.campaignPatientId },
      select: { id: true, messages: true, turnCount: true },
    });

    if (patient) {
      await this.prisma.campaignPatient.update({
        where: { id: patient.id },
        data:  { messages: session.messages as any },
      });
    }

    this.logger.log(`Staff message sent to ${phone} and persisted`);
    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RELEASE TO BOT — staff hands conversation back to AI
  // ═══════════════════════════════════════════════════════════════════════════

  async releaseToBot(clinicId: string, phone: string): Promise<{ ok: true }> {
    this.logger.log(`releaseToBot — clinicId=${clinicId} phone=${phone}`);

    const session = await this.sessionsService.getCampaignSession(phone);

    if (!session) {
      throw new BadRequestException(
        `No campaign session found for ${phone}`,
      );
    }

    if (session.clinicId !== clinicId) {
      throw new BadRequestException(
        `Session for ${phone} does not belong to clinic ${clinicId}`,
      );
    }

    if (session.status !== 'admin_handling') {
      // Idempotent — if already active or awaiting_reply, that's fine
      if (session.status === 'active' || session.status === 'awaiting_reply') {
        this.logger.warn(
          `Session for ${phone} is already "${session.status}" — idempotent releaseToBot`,
        );
        return { ok: true };
      }

      throw new BadRequestException(
        `Session for ${phone} is in status "${session.status}" — cannot release`,
      );
    }

    // ── Set status back to active so bot picks up next incoming message ────
    session.status = 'active';
    await this.sessionsService.saveCampaignSession(session);

    this.logger.log(`Bot resumed for ${phone}`);
    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GET ACTIVE HANDOVERS — list all sessions currently in admin_handling
  // ═══════════════════════════════════════════════════════════════════════════

  async getActiveHandovers(clinicId: string): Promise<ActiveHandover[]> {
    this.logger.log(`getActiveHandovers — clinicId=${clinicId}`);

    // ── Scan all campaign Redis keys ───────────────────────────────────────
    const keys = await this.sessionsService.scanCampaignKeys();

    if (keys.length === 0) return [];

    const redis   = this.sessionsService.getClient();
    const results: ActiveHandover[] = [];

    for (const key of keys) {
      try {
        const raw = await redis.get(key);
        if (!raw) continue;

        const session = JSON.parse(raw);
        if (session.status !== 'admin_handling') continue;
        if (session.clinicId !== clinicId) continue;

        // Load patient name from DB
        const patient = await this.prisma.campaignPatient.findUnique({
          where:  { id: session.campaignPatientId },
          select: { id: true, patientName: true, campaignId: true },
        });

        if (!patient) continue;

        results.push({
          campaignPatientId: session.campaignPatientId,
          campaignId:        patient.campaignId,
          phone:             session.phone,
          patientName:       patient.patientName,
          clinicId:          session.clinicId,
          takenOverAt:       session.lastActivityAt,
          lastActivityAt:    session.lastActivityAt,
          turnCount:         session.turnCount,
          language:          session.language ?? null,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to parse campaign session key "${key}": ${msg}`);
      }
    }

    // Sort by most recently active first
    results.sort((a, b) => b.lastActivityAt - a.lastActivityAt);

    this.logger.log(`Found ${results.length} active handover(s) for clinic ${clinicId}`);
    return results;
  }
}