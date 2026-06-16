import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Language } from '@prisma/client';

export enum SessionState {
  IDLE = 'IDLE',
  LANGUAGE_SELECT = 'LANGUAGE_SELECT',
  AWAITING_NAME = 'AWAITING_NAME',
  BOOKING_SPECIALTY = 'BOOKING_SPECIALTY',
  BOOKING_DOCTOR = 'BOOKING_DOCTOR',
  BOOKING_DATE = 'BOOKING_DATE',
  BOOKING_TIME = 'BOOKING_TIME',
  BOOKING_CONFIRM = 'BOOKING_CONFIRM',
  FAQ_BROWSING = 'FAQ_BROWSING',
  AWAITING_HANDOFF = 'AWAITING_HANDOFF',
}

export interface SessionData {
  clinicId: string;
  timezone: string;
  language: Language;
  languageConfirmed: boolean;
  patientName?: string;
  specialtyId?: string;
  doctorId?: string;
  selectedDate?: string; // ISO date "2026-06-10"
  selectedTime?: string; // "10:30"
}

export interface Session {
  phone: string;
  state: SessionState;
  data: SessionData;
  updatedAt: number; // unix ms
  version: number;   // bumped when session structure changes incompatibly
}

export interface SessionResult {
  session: Session;
  isNew: boolean;
}

// Bump this ONLY when SessionData/SessionState structure changes in a
// breaking way (e.g. adding a required field, renaming a field).
// On mismatch, the user's session is reset gracefully on their next message
// instead of crashing or behaving unexpectedly.
// DO NOT bump for every deploy — only for breaking session shape changes.
export const SESSION_VERSION = 1;

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);
  private readonly redis: Redis;
  private readonly TTL = 30 * 60; // 30 minutes in seconds

  constructor(private configService: ConfigService) {
    const redisUrl =
      this.configService.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
    const isUpstash = redisUrl.includes('upstash.io');

    this.redis = new Redis(redisUrl, {
      tls: isUpstash ? {} : undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });

    this.redis.on('connect', () =>
      this.logger.log('SessionsService connected to Redis'),
    );
    this.redis.on('error', (err) =>
      this.logger.error('Redis error in SessionsService', err.message),
    );
  }

  private key(phone: string): string {
    return `session:${phone}`;
  }

  async getOrCreate(
    phone: string,
    clinicId: string,
    defaultLanguage: Language,
    timezone: string,
  ): Promise<SessionResult> {
    const existing = await this.redis.get(this.key(phone));

    if (existing) {
      const session = JSON.parse(existing) as Session;

      // ── Structural migration: no data field (very old sessions) ──────
      if (!session.data) {
        this.logger.warn(`Session ${phone} has no data field — resetting`);
        const fresh = this.createFreshSession(phone, clinicId, defaultLanguage, timezone);
        await this.save(fresh);
        return { session: fresh, isNew: true };
      }

      // ── Version mismatch: session shape changed incompatibly ──────────
      // Reset this user's session gracefully. No global flush needed.
      if (!session.version || session.version !== SESSION_VERSION) {
        this.logger.warn(
          `Session version mismatch for ${phone} ` +
          `(got ${session.version ?? 'none'}, expected ${SESSION_VERSION}) — resetting`,
        );
        const fresh = this.createFreshSession(phone, clinicId, defaultLanguage, timezone);
        await this.save(fresh);
        return { session: fresh, isNew: true };
      }

      return { session, isNew: false };
    }

    const fresh = this.createFreshSession(phone, clinicId, defaultLanguage, timezone);
    await this.save(fresh);
    return { session: fresh, isNew: true };
  }

  private createFreshSession(
    phone: string,
    clinicId: string,
    defaultLanguage: Language,
    timezone: string,
  ): Session {
    return {
      phone,
      state: SessionState.IDLE,
      version: SESSION_VERSION,
      data: {
        clinicId,
        timezone,
        language: defaultLanguage,
        languageConfirmed: false,
      },
      updatedAt: Date.now(),
    };
  }

  async save(session: Session): Promise<void> {
    session.updatedAt = Date.now();
    await this.redis.setex(
      this.key(session.phone),
      this.TTL,
      JSON.stringify(session),
    );
  }

  async reset(phone: string): Promise<void> {
    const existing = await this.redis.get(this.key(phone));
    if (existing) {
      const parsed = JSON.parse(existing) as Session;
      const fresh: Session = {
        phone,
        state: SessionState.IDLE,
        version: SESSION_VERSION,
        data: {
          clinicId: parsed.data.clinicId,
          timezone: parsed.data.timezone,
          language: parsed.data.language,
          languageConfirmed: false, // re-detect language on next message
          // patientName intentionally NOT carried over — always re-ask name
        },
        updatedAt: Date.now(),
      };
      await this.save(fresh);
    }
  }

  async scanKeys(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const stream = this.redis.scanStream({ match: 'session:*', count: 100 });
      const keys: string[] = [];
      stream.on('data', (resultKeys: string[]) => {
        for (const key of resultKeys) keys.push(key);
      });
      stream.on('end', () => resolve(keys));
      stream.on('error', (err) => reject(err));
    });
  }

  async delete(phone: string): Promise<void> {
    await this.redis.del(this.key(phone));
  }
}