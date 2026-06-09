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
  language: Language; // detected on first message — FR or EN
  languageConfirmed: boolean; // true once user has confirmed or chosen language
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

  async getOrCreate(phone: string, clinicId: string, defaultLanguage: Language): Promise<Session> {
    const existing = await this.redis.get(this.key(phone));

    if (existing) {
      const session = JSON.parse(existing) as Session;
      // Basic migration if old structure exists
      if (!session.data) {
        return this.createFreshSession(phone, clinicId, defaultLanguage);
      }
      return session;
    }

    return this.createFreshSession(phone, clinicId, defaultLanguage);
  }

  private async createFreshSession(phone: string, clinicId: string, defaultLanguage: Language): Promise<Session> {
    const fresh: Session = {
      phone,
      state: SessionState.IDLE,
      data: {
        clinicId,
        language: defaultLanguage,
        languageConfirmed: false,
      },
      updatedAt: Date.now(),
    };

    await this.save(fresh);
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
    const session = await this.redis.get(this.key(phone));
    if(session){
        const parsed = JSON.parse(session) as Session;
        const fresh = await this.createFreshSession(phone, parsed.data.clinicId, parsed.data.language);
        await this.save(fresh);
    }
  }

  async delete(phone: string): Promise<void> {
    await this.redis.del(this.key(phone));
  }
}