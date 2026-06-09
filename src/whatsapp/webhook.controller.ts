import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as crypto from 'crypto';
import { QUEUES, JOBS } from '../queue/queue.constants';
import { MessageJob } from '../queue/message.processor';

@Controller('webhook')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    private configService: ConfigService,
    @InjectQueue(QUEUES.MESSAGES) private messageQueue: Queue,
  ) {}

  @Get()
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    const verifyToken = this.configService.get<string>('whatsapp.verifyToken');

    if (mode === 'subscribe' && token === verifyToken) {
      this.logger.log('Webhook verified by Meta');
      return challenge;
    }

    this.logger.warn('Webhook verification failed — token mismatch');
    throw new UnauthorizedException('Verification failed');
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async receiveMessage(
    @Body() body: any,
    @Headers('x-hub-signature-256') signature: string,
  ): Promise<{ status: string }> {
    const isValid = this.verifySignature(JSON.stringify(body), signature);

    if (!isValid) {
      this.logger.warn('Invalid signature — request rejected');
      throw new UnauthorizedException('Invalid signature');
    }

    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const contact = body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0];

    if (!message) {
      return { status: 'ok' };
    }

    const text =
      message.type === 'text'
        ? message.text?.body
        : message.type === 'interactive'
          ? message.interactive?.button_reply?.title ||
            message.interactive?.list_reply?.title
          : null;

    if (!text) {
      return { status: 'ok' };
    }

    const job: MessageJob = {
      from: message.from,
      name: contact?.profile?.name || 'Patient',
      text,
      messageId: message.id,
      timestamp: message.timestamp,
    };

    await this.messageQueue.add(JOBS.PROCESS_MESSAGE, job, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      removeOnComplete: 100,
      removeOnFail: 50,
    });

    this.logger.log(`Job queued for ${message.from}`);
    return { status: 'ok' };
  }

  private verifySignature(payload: string, signature: string): boolean {
    const nodeEnv = this.configService.get<string>('nodeEnv');

    // Skip verification in development — production enforces it
    if (nodeEnv === 'development') {
      return true;
    }

    const appSecret = this.configService.get<string>('whatsapp.appSecret');
    if (!appSecret) return true;
    if (!signature) return false;

    const expected = `sha256=${crypto
      .createHmac('sha256', appSecret)
      .update(payload)
      .digest('hex')}`;

    try {
      return crypto.timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(signature),
      );
    } catch {
      return false;
    }
  }
}