import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  Headers,
  Res,
  HttpCode,
  Logger,
  UnauthorizedException,
  BadRequestException,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import * as crypto from 'crypto';
import { WhatsAppService } from './whatsapp.service';

@Controller('webhook')
export class WhatsAppController {
  private readonly logger = new Logger(WhatsAppController.name);

  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly configService: ConfigService,
  ) {}

  // ─── GET /webhook — Meta webhook verification handshake ──────────────────
  // Meta sends this once when you save the webhook URL in the developer console.
  // Must respond with hub.challenge as plain text within 5 seconds.
  @Get()
  verifyWebhook(
    @Query('hub.mode')         mode:      string,
    @Query('hub.verify_token') token:     string,
    @Query('hub.challenge')    challenge: string,
    @Res() res: Response,
  ): void {
    const verifyToken = this.configService.get<string>('whatsapp.verifyToken');

    if (mode === 'subscribe' && token === verifyToken) {
      this.logger.log('✅ Meta webhook verified successfully');
      res.status(200).send(challenge);
      return;
    }

    this.logger.warn(`❌ Webhook verification failed — mode=${mode} token=${token}`);
    res.status(403).send('Forbidden');
  }

  // ─── POST /webhook — incoming messages from Meta ──────────────────────────
  // Meta signs every payload with HMAC-SHA256 using your App Secret.
  // We use the RAW request body bytes for verification — re-stringifying
  // the parsed JSON object would break the signature due to byte differences.
  @Post()
  @HttpCode(200)
  async receiveWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string,
    @Body() body: any,
  ): Promise<string> {
    // ── Signature verification using raw bytes ────────────────────────────
    this.verifySignature(signature, req.rawBody);

    // ── Hand off to service ───────────────────────────────────────────────
    // Meta requires a 200 OK within 5 seconds.
    // We enqueue jobs and return immediately — all processing is async.
    try {
      await this.whatsappService.handleIncomingWebhook(body);
    } catch (error: any) {
      // Never return non-200 to Meta — it will keep retrying the same payload
      this.logger.error('Error handling webhook payload', error?.message);
    }

    return 'EVENT_RECEIVED';
  }

  // ─── HMAC-SHA256 signature verification ──────────────────────────────────

  private verifySignature(signature: string, rawBody: Buffer | undefined): void {
    const appSecret = this.configService.get<string>('whatsapp.appSecret');

    if (!appSecret) {
      if (this.configService.get<string>('nodeEnv') !== 'production') {
        this.logger.warn('META_APP_SECRET not set — skipping signature check (dev only)');
        return;
      }
      throw new Error('META_APP_SECRET must be set in production');
    }

    if (!signature) {
      throw new UnauthorizedException('Missing x-hub-signature-256 header');
    }

    const parts = signature.split('=');
    if (parts.length !== 2 || parts[0] !== 'sha256') {
      throw new BadRequestException('Malformed x-hub-signature-256 header');
    }

    if (!rawBody) {
      throw new BadRequestException('Raw body unavailable — ensure rawBody:true in NestFactory.create()');
    }

    const expected = crypto
      .createHmac('sha256', appSecret)
      .update(rawBody)
      .digest('hex');

    const trusted  = Buffer.from(parts[1], 'hex');
    const computed = Buffer.from(expected,  'hex');

    if (
      trusted.length !== computed.length ||
      !crypto.timingSafeEqual(trusted, computed)
    ) {
      this.logger.warn('❌ Webhook signature mismatch — request rejected');
      throw new UnauthorizedException('Invalid webhook signature');
    }
  }
}