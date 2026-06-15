import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Language } from '@prisma/client';

export enum SessionState {
  IDLE = 'IDLE',
  LANGUAGE_SELECT = 'LANGUAGE_SELECT', // shown if detection is ambiguous
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
  timezone: string;        // e.g. "Africa/Casablanca" — populated from clinic.timezone
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
}

export interface SessionResult {
  session: Session;
  isNew: boolean; // true if session was just created (previous one expired or first visit)
}

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

  async getOrCreate(phone: string, clinicId: string, defaultLanguage: Language, timezone: string): Promise<SessionResult> {
    const existing = await this.redis.get(this.key(phone));

    if (existing) {
      const session = JSON.parse(existing) as Session;
      // Basic migration if old structure exists
      if (!session.data) {
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

  private createFreshSession(phone: string, clinicId: string, defaultLanguage: Language, timezone: string): Session {
    const fresh: Session = {
      phone,
      state: SessionState.IDLE,
      data: {
        clinicId,
        timezone,
        language: defaultLanguage,
        languageConfirmed: false,
      },
      updatedAt: Date.now(),
    };

    return fresh;
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
      // Preserve language, languageConfirmed, clinicId, timezone
      // Reset only booking fields
      const fresh: Session = {
        phone,
        state: SessionState.IDLE,
        data: {
          clinicId: parsed.data.clinicId,
          timezone: parsed.data.timezone,
          language: parsed.data.language,
          languageConfirmed: parsed.data.languageConfirmed,
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