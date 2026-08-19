import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Language } from '@prisma/client';

// ─── Reactive bot session (existing flow) ────────────────────────────────────
export enum SessionState {
  IDLE              = 'IDLE',
  LANGUAGE_SELECT   = 'LANGUAGE_SELECT',
  AWAITING_NAME     = 'AWAITING_NAME',
  BOOKING_SPECIALTY = 'BOOKING_SPECIALTY',
  BOOKING_DOCTOR    = 'BOOKING_DOCTOR',
  BOOKING_DATE      = 'BOOKING_DATE',
  BOOKING_TIME      = 'BOOKING_TIME',
  BOOKING_CONFIRM   = 'BOOKING_CONFIRM',
  FAQ_BROWSING      = 'FAQ_BROWSING',
  AWAITING_HANDOFF  = 'AWAITING_HANDOFF',
}

export interface SessionData {
  clinicId:          string;
  timezone:          string;
  language:          Language;
  languageConfirmed: boolean;
  patientName?:      string;
  specialtyId?:      string;
  doctorId?:         string;
  selectedDate?:     string;
  selectedTime?:     string;
}

export interface Session {
  phone:     string;
  state:     SessionState;
  data:      SessionData;
  updatedAt: number;
  version:   number;
}

export interface SessionResult {
  session: Session;
  isNew:   boolean;
}

// ─── Campaign conversation session (AI follow-up flow) ───────────────────────
export interface CampaignMessage {
  role:      'assistant' | 'user';
  content:   string;
  timestamp: number;
}

export interface CampaignSession {
  phone:             string;
  campaignPatientId: string;
  clinicId:          string;
  patientSnapshot:   Record<string, any>;
  language:          Language | null;
  messages:          CampaignMessage[];
  turnCount:         number;
  remindersSent:     number;
  status:            'awaiting_reply' | 'active' | 'admin_handling' | 'completed' | 'handed_off';
  startedAt:         number;
  lastActivityAt:    number;
}

// ─── Version ──────────────────────────────────────────────────────────────────
// Bump ONLY on breaking SessionData/SessionState shape changes.
export const SESSION_VERSION = 1;

// ─── TTLs ─────────────────────────────────────────────────────────────────────
const REACTIVE_SESSION_TTL = 30 * 60;           // 30 min
const CAMPAIGN_SESSION_TTL = 7 * 24 * 60 * 60;  // 7 days
const DEDUP_TTL            = 5 * 60;             // 5 min

@Injectable()
export class SessionsService implements OnModuleDestroy {
  private readonly logger = new Logger(SessionsService.name);
  private readonly redis:  Redis;

  constructor(private readonly configService: ConfigService) {
    const redisUrl  = this.configService.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
    const isUpstash = redisUrl.includes('upstash.io');

    this.redis = new Redis(redisUrl, {
      tls:                  isUpstash ? {} : undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck:     false,
      retryStrategy(times) {
        if (times > 10) return null;
        return Math.min(times * 200, 30_000);
      },
      reconnectOnError(err) {
        return (
          err.message.includes('READONLY') ||
          err.message.includes('ECONNRESET')
        );
      },
    });

    this.redis.on('connect',      () => this.logger.log('SessionsService connected to Redis'));
    this.redis.on('reconnecting', () => this.logger.warn('SessionsService reconnecting to Redis...'));
    this.redis.on('error',        (err) => this.logger.error('Redis error', err.message));
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  // Expose shared Redis client — other services use this instead of
  // creating their own connections.
  getClient(): Redis {
    return this.redis;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHONE NORMALIZATION — SINGLE SOURCE OF TRUTH
  // ═══════════════════════════════════════════════════════════════════════════
  // PRODUCTION FIX: previously every caller (whatsapp.service.ts,
  // conversation.service.ts, campaign.service.ts, message.processor.ts) had
  // to remember to normalize phone numbers identically before touching a
  // session. They didn't, consistently. A campaign patient's phone could be
  // stored as "+212644..." from ClinOps while the inbound webhook delivers
  // "212644..." (Meta's format, no +). Two different Redis keys for the same
  // physical patient meant campaign sessions became invisible to inbound
  // lookups — the exact mechanism behind messages falling through to the
  // reactive/inbound flow instead of being recognized as handed-off.
  //
  // Fix: normalization now happens ONCE, here, and every public method in
  // this class runs the phone argument through it before touching Redis.
  // Callers can pass phone in ANY format (with +, with spaces, local format
  // with leading 0) and always resolve to the same key.
  private normalizePhone(phone: string): string {
    if (!phone) return phone;

    let normalized = phone.trim().replace(/[\s\-()]/g, '').replace(/^\+/, '');

    // Moroccan local format safety net: numbers starting with a bare "0"
    // (e.g. "0644xxxxxx", 10 digits) are missing the country code. Meta's
    // webhook and WhatsApp always deliver full E.164 without the leading 0,
    // so a raw ClinOps export using local format must be corrected here or
    // it will never match an inbound key. Adjust the "212" prefix if you
    // ever expand outside Morocco.
    if (/^0\d{9}$/.test(normalized)) {
      normalized = `212${normalized.slice(1)}`;
    }

    return normalized;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REACTIVE BOT SESSIONS  key: session:<phone>
  // ═══════════════════════════════════════════════════════════════════════════

  private reactiveKey(phone: string): string {
    return `session:${this.normalizePhone(phone)}`;
  }

  async getOrCreate(
    phone:           string,
    clinicId:        string,
    defaultLanguage: Language,
    timezone:        string,
  ): Promise<SessionResult> {
    const normalizedPhone = this.normalizePhone(phone);
    const raw = await this.redis.get(this.reactiveKey(normalizedPhone));

    if (raw) {
      let session: Session;

      try {
        session = JSON.parse(raw) as Session;
      } catch {
        this.logger.warn(`Corrupted session for ${normalizedPhone} — resetting`);
        const fresh = this.buildFreshReactiveSession(normalizedPhone, clinicId, defaultLanguage, timezone);
        await this.saveReactive(fresh);
        return { session: fresh, isNew: true };
      }

      if (!session.data) {
        this.logger.warn(`Session ${normalizedPhone} missing data field — resetting`);
        const fresh = this.buildFreshReactiveSession(normalizedPhone, clinicId, defaultLanguage, timezone);
        await this.saveReactive(fresh);
        return { session: fresh, isNew: true };
      }

      if (!session.version || session.version !== SESSION_VERSION) {
        this.logger.warn(
          `Session version mismatch for ${normalizedPhone} ` +
          `(got ${session.version ?? 'none'}, expected ${SESSION_VERSION}) — resetting`,
        );
        const fresh = this.buildFreshReactiveSession(normalizedPhone, clinicId, defaultLanguage, timezone);
        await this.saveReactive(fresh);
        return { session: fresh, isNew: true };
      }

      return { session, isNew: false };
    }

    const fresh = this.buildFreshReactiveSession(normalizedPhone, clinicId, defaultLanguage, timezone);
    await this.saveReactive(fresh);
    return { session: fresh, isNew: true };
  }

  private buildFreshReactiveSession(
    phone:           string,
    clinicId:        string,
    defaultLanguage: Language,
    timezone:        string,
  ): Session {
    return {
      phone: this.normalizePhone(phone),
      state:   SessionState.IDLE,
      version: SESSION_VERSION,
      data: {
        clinicId,
        timezone,
        language:          defaultLanguage,
        languageConfirmed: false,
      },
      updatedAt: Date.now(),
    };
  }

  async saveReactive(session: Session): Promise<void> {
    session.phone = this.normalizePhone(session.phone);
    session.updatedAt = Date.now();
    await this.redis.setex(
      this.reactiveKey(session.phone),
      REACTIVE_SESSION_TTL,
      JSON.stringify(session),
    );
  }

  // Alias — keeps existing callers working without changes
  async save(session: Session): Promise<void> {
    return this.saveReactive(session);
  }

  async reset(phone: string): Promise<void> {
    const normalizedPhone = this.normalizePhone(phone);
    const raw = await this.redis.get(this.reactiveKey(normalizedPhone));
    if (!raw) return;

    let parsed: Session;
    try {
      parsed = JSON.parse(raw) as Session;
    } catch {
      await this.redis.del(this.reactiveKey(normalizedPhone));
      return;
    }

    const fresh: Session = {
      phone: normalizedPhone,
      state:   SessionState.IDLE,
      version: SESSION_VERSION,
      data: {
        clinicId:          parsed.data.clinicId,
        timezone:          parsed.data.timezone,
        language:          parsed.data.language,
        languageConfirmed: false,
      },
      updatedAt: Date.now(),
    };
    await this.saveReactive(fresh);
  }

  async delete(phone: string): Promise<void> {
    await this.redis.del(this.reactiveKey(phone));
  }

  async scanKeys(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const stream = this.redis.scanStream({ match: 'session:*', count: 100 });
      const keys: string[] = [];

      stream.on('data', (resultKeys: string[]) => {
        for (const key of resultKeys) {
          if (typeof key === 'string') keys.push(key);
        }
      });
      stream.on('end',   () => resolve(keys));
      stream.on('error', (err) => reject(err));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CAMPAIGN SESSIONS  key: campaign:<phone>
  // ═══════════════════════════════════════════════════════════════════════════

  private campaignKey(phone: string): string {
    return `campaign:${this.normalizePhone(phone)}`;
  }

  async getCampaignSession(phone: string): Promise<CampaignSession | null> {
    const raw = await this.redis.get(this.campaignKey(phone));
    if (!raw) return null;

    try {
      return JSON.parse(raw) as CampaignSession;
    } catch {
      this.logger.warn(`Corrupted campaign session for ${phone} — deleting`);
      await this.redis.del(this.campaignKey(phone));
      return null;
    }
  }

  async saveCampaignSession(session: CampaignSession): Promise<void> {
    session.phone = this.normalizePhone(session.phone);
    session.lastActivityAt = Date.now();
    await this.redis.setex(
      this.campaignKey(session.phone),
      CAMPAIGN_SESSION_TTL,
      JSON.stringify(session),
    );
  }

  async deleteCampaignSession(phone: string): Promise<void> {
    await this.redis.del(this.campaignKey(phone));
  }

  async hasActiveCampaignSession(phone: string): Promise<boolean> {
    const session = await this.getCampaignSession(phone);
    if (!session) return false;
    return session.status === 'awaiting_reply' || session.status === 'active';
  }

  async isHandoffCampaignSession(phone: string): Promise<boolean> {
    const session = await this.getCampaignSession(phone);
    if (!session) return false;
    return session.status === 'handed_off' || session.status === 'admin_handling';
  }

  async scanCampaignKeys(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const stream = this.redis.scanStream({ match: 'campaign:*', count: 100 });
      const keys: string[] = [];

      stream.on('data', (resultKeys: string[]) => {
        for (const key of resultKeys) {
          if (typeof key === 'string') keys.push(key);
        }
      });
      stream.on('end',   () => resolve(keys));
      stream.on('error', (err) => reject(err));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MESSAGE DEDUPLICATION  key: processed:<messageId>
  // ═══════════════════════════════════════════════════════════════════════════

  async markMessageProcessed(messageId: string): Promise<boolean> {
    const key   = `processed:${messageId}`;
    const isNew = await this.redis.set(key, '1', 'EX', DEDUP_TTL, 'NX');
    return isNew === 'OK';
  }
}