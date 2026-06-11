import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
  WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as path from 'path';
import * as QRCode from 'qrcode';
import { QUEUES, JOBS } from '../queue/queue.constants';
import type { MessageJob } from '../queue/message.processor';

@Injectable()
export class WhatsAppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppService.name);
  private sock: WASocket | null = null;
  private authPath: string;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_DELAY = 60_000;

  // QR state — read by QrController
  public qrDataUrl: string | null = null;
  public isConnected = false;

  constructor(
    private readonly configService: ConfigService,
    @InjectQueue(QUEUES.MESSAGES) private readonly messageQueue: Queue,
  ) {
    this.authPath =
      this.configService.get<string>('whatsapp.authPath') ??
      path.join(process.cwd(), 'baileys-auth');
  }

  async onModuleInit() {
    await this.connect();
  }

  async onModuleDestroy() {
    this.isShuttingDown = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    this.logger.log('WhatsApp service shut down cleanly');
  }

  // ─── Connection ────────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
      const { version } = await fetchLatestBaileysVersion();

      this.logger.log(`Connecting with Baileys v${version.join('.')}`);

      this.sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, {
            level: 'silent',
            trace: () => { },
            debug: () => { },
            info: () => { },
            warn: () => { },
            error: () => { },
            fatal: () => { },
            child: () => ({} as any),
          } as any),
        },
        printQRInTerminal: true,
        logger: {
          level: 'silent',
          trace: () => { },
          debug: () => { },
          info: () => { },
          warn: (msg: any) => this.logger.warn(JSON.stringify(msg)),
          error: (msg: any) => this.logger.error(JSON.stringify(msg)),
          fatal: (msg: any) => this.logger.error(JSON.stringify(msg)),
          child: () => ({
            level: 'silent',
            trace: () => { },
            debug: () => { },
            info: () => { },
            warn: () => { },
            error: () => { },
            fatal: () => { },
            child: () => ({} as any),
          }),
        } as any,
        markOnlineOnConnect: false,
        syncFullHistory: false,
      });

      this.sock.ev.on('creds.update', saveCreds);
      this.sock.ev.on('connection.update', (update: any) =>
        this.onConnectionUpdate(update),
      );
      this.sock.ev.on('messages.upsert', (upsert: any) =>
        this.onMessage(upsert),
      );
    } catch (error) {
      this.logger.error('Failed to initialize Baileys connection', error);
      this.scheduleReconnect();
    }
  }

  private async onConnectionUpdate(update: {
    connection?: string;
    lastDisconnect?: { error?: Error };
    qr?: string;
  }): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.logger.log('📱 QR code ready — visit scan.houdaifa.dev to scan');
      try {
        this.qrDataUrl = await QRCode.toDataURL(qr, { width: 400, margin: 2 });
      } catch (err) {
        this.logger.error('Failed to generate QR data URL', err);
      }
    }

    if (connection === 'open') {
      this.isConnected = true;
      this.qrDataUrl = null;
      this.reconnectAttempts = 0;
      this.logger.log('✅ WhatsApp connected successfully');
    }

    if (connection === 'close') {
      this.isConnected = false;
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      this.logger.warn(
        `Connection closed — reason: ${statusCode} — reconnect: ${shouldReconnect}`,
      );

      this.sock = null;

      if (statusCode === DisconnectReason.loggedOut) {
        this.logger.error(
          '🚨 Logged out — visit scan.houdaifa.dev to re-scan QR code',
        );
        // Still reconnect — will show new QR
        this.scheduleReconnect(3000);
      } else if (shouldReconnect && !this.isShuttingDown) {
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(overrideDelay?: number): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    const delay =
      overrideDelay ??
      Math.min(
        5000 * Math.pow(2, this.reconnectAttempts),
        this.MAX_RECONNECT_DELAY,
      );

    this.reconnectAttempts++;
    this.logger.log(
      `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );

    this.reconnectTimer = setTimeout(async () => {
      await this.connect();
    }, delay);
  }

  // ─── Incoming messages ─────────────────────────────────────────────────────

  private async onMessage(upsert: {
    messages: proto.IWebMessageInfo[];
    type: string;
  }): Promise<void> {
    if (upsert.type !== 'notify') return;

    for (const msg of upsert.messages) {
      if (!msg.key) continue;
      if (msg.key.fromMe) continue;
      if (!msg.key.remoteJid) continue;

      const jid = msg.key.remoteJid;
      if (jid.endsWith('@g.us')) continue;

      const phone = jid.replace('@s.whatsapp.net', '');
      const name = msg.pushName ?? 'Patient';
      const text = this.extractText(msg);
      if (!text) continue;

      const job: MessageJob = {
        from: phone,
        name,
        text,
        messageId: msg.key?.id ?? '',
        timestamp: String(msg.messageTimestamp ?? Date.now()),
      };

      await this.messageQueue.add(JOBS.PROCESS_MESSAGE, job, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 50,
      });

      this.logger.log(`Job queued for ${phone}`);
    }
  }

  private extractText(msg: proto.IWebMessageInfo): string | null {
    const m = msg.message;
    if (!m) return null;
    return (
      m.conversation ??
      m.extendedTextMessage?.text ??
      m.buttonsResponseMessage?.selectedDisplayText ??
      m.listResponseMessage?.title ??
      m.templateButtonReplyMessage?.selectedDisplayText ??
      null
    );
  }

  // ─── Outgoing messages ─────────────────────────────────────────────────────

  private jid(phone: string): string {
    return `${phone.replace(/^\+/, '').replace(/\s/g, '')}@s.whatsapp.net`;
  }

  async sendText(to: string, body: string): Promise<void> {
    if (!this.sock) {
      this.logger.warn(`sendText — not connected, dropping message to ${to}`);
      return;
    }
    try {
      await this.sock.sendMessage(this.jid(to), { text: body });
      this.logger.log(`Text sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send text to ${to}`, error);
      throw error;
    }
  }

  async sendButtons(
    to: string,
    bodyText: string,
    buttons: { id: string; title: string }[],
  ): Promise<void> {
    if (!this.sock) {
      this.logger.warn(`sendButtons — not connected, dropping message to ${to}`);
      return;
    }
    try {
      // Safe text-based numbered menu — works on every WhatsApp client
      const numbered = buttons
        .map((btn, i) => `${i + 1}. ${btn.title}`)
        .join('\n');
      const full = `${bodyText}\n\n${numbered}`;
      await this.sock.sendMessage(this.jid(to), { text: full });
      this.logger.log(`Buttons (text menu) sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send buttons to ${to}`, error);
      throw error;
    }
  }

  async sendInteractiveList(
    to: string,
    header: string,
    body: string,
    _buttonLabel: string,
    sections: {
      title: string;
      rows: { id: string; title: string; description?: string }[];
    }[],
  ): Promise<void> {
    if (!this.sock) {
      this.logger.warn(`sendInteractiveList — not connected, dropping message to ${to}`);
      return;
    }
    try {
      // Safe text-based numbered list — works on every WhatsApp client
      let text = `*${header}*\n${body}\n`;
      let index = 1;
      for (const section of sections) {
        if (section.title) text += `\n*${section.title}*\n`;
        for (const row of section.rows) {
          text += `${index}. ${row.title}`;
          if (row.description) text += ` — ${row.description}`;
          text += '\n';
          index++;
        }
      }
      await this.sock.sendMessage(this.jid(to), { text });
      this.logger.log(`List (text menu) sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send list to ${to}`, error);
      throw error;
    }
  }
}