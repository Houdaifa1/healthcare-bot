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

// How long (ms) a QR code is valid before WhatsApp rejects it
const QR_TTL_MS = 20_000;

// How long send methods will wait for a live connection before giving up
const SEND_CONNECTION_TIMEOUT_MS = 20_000;

@Injectable()
export class WhatsAppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppService.name);
  private sock: WASocket | null = null;
  private authPath: string;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_DELAY = 60_000;

  // ── QR state — read by QrController ──────────────────────────────────────
  public qrDataUrl: string | null = null;
  public qrRawString: string | null = null;
  public qrGeneratedAt: number | null = null;
  public isConnected = false;

  // Listeners waiting for the connection to become ready
  private connectionReadyListeners: Array<() => void> = [];

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
    this.connectionReadyListeners = [];
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    this.logger.log('WhatsApp service shut down cleanly');
  }

  // ─── Public helpers ───────────────────────────────────────────────────────

  get qrIsValid(): boolean {
    return !!this.qrDataUrl;
  }

  get qrSecondsRemaining(): number {
    if (!this.qrGeneratedAt) return 0;
    return Math.max(
      0,
      Math.floor((QR_TTL_MS - (Date.now() - this.qrGeneratedAt)) / 1000),
    );
  }

  get qrAgeSeconds(): number {
    if (!this.qrGeneratedAt) return 0;
    return Math.floor((Date.now() - this.qrGeneratedAt) / 1000);
  }

  // ─── Connection-ready gate ─────────────────────────────────────────────────

  /**
   * Resolves as soon as the socket is connected and ready.
   * If already connected, resolves immediately.
   * Rejects after timeoutMs to prevent hanging jobs.
   */
  private waitForConnection(
    timeoutMs: number = SEND_CONNECTION_TIMEOUT_MS,
  ): Promise<void> {
    if (this.isConnected && this.sock) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectionReadyListeners = this.connectionReadyListeners.filter(
          (l) => l !== onReady,
        );
        reject(
          new Error(
            `WhatsApp not connected after ${timeoutMs}ms — message will be retried`,
          ),
        );
      }, timeoutMs);

      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };

      this.connectionReadyListeners.push(onReady);
    });
  }

  /** Called internally when the connection becomes open */
  private notifyConnectionReady(): void {
    const listeners = this.connectionReadyListeners.splice(0);
    for (const listener of listeners) {
      listener();
    }
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
      this.logger.log('📱 New QR code generated — valid for ~18s');
      try {
        this.qrRawString = qr;
        this.qrGeneratedAt = Date.now();
        this.qrDataUrl = await QRCode.toDataURL(qr, { width: 400, margin: 2 });
      } catch (err) {
        this.logger.error('Failed to generate QR data URL', err);
      }
    }

    if (connection === 'open') {
      this.isConnected = true;
      this.qrDataUrl = null;
      this.qrRawString = null;
      this.qrGeneratedAt = null;
      this.reconnectAttempts = 0;
      this.logger.log('✅ WhatsApp connected successfully');
      // Unblock any send methods that were waiting
      this.notifyConnectionReady();
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
        this.scheduleReconnect(3_000);
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
        5_000 * Math.pow(2, this.reconnectAttempts),
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

      const remoteJid = msg.key.remoteJid;

      // Skip group messages
      if (remoteJid.endsWith('@g.us')) continue;

      const name = msg.pushName ?? 'Patient';
      const text = this.extractText(msg);
      if (!text) continue;

      // Store the full remoteJid as-is so we can reply to the correct JID.
      // Whether it ends with @s.whatsapp.net or @lid, we preserve it and
      // use it directly when sending — no suffix mangling.
      const job: MessageJob = {
        from: remoteJid,
        name,
        text,
        messageId: msg.key?.id ?? '',
        timestamp: String(msg.messageTimestamp ?? Date.now()),
      };

      await this.messageQueue.add(JOBS.PROCESS_MESSAGE, job, {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 100,
        removeOnFail: 50,
      });

      this.logger.log(`Job queued for ${remoteJid}`);
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

  // ─── JID helper ───────────────────────────────────────────────────────────

  /**
   * Returns a sendable JID.
   * - If the input already contains '@' (e.g. @s.whatsapp.net or @lid),
   *   it is returned as-is — Baileys knows how to handle both formats.
   * - Otherwise a bare phone number is normalized and suffixed with
   *   @s.whatsapp.net.
   */
  private toJid(phoneOrJid: string): string {
    if (phoneOrJid.includes('@')) {
      return phoneOrJid;
    }
    return `${phoneOrJid.replace(/^\+/, '').replace(/\s/g, '')}@s.whatsapp.net`;
  }

  // ─── Outgoing messages ─────────────────────────────────────────────────────

  async sendText(to: string, body: string): Promise<void> {
    await this.waitForConnection();

    // Re-read sock after the await — it is guaranteed non-null now
    const sock = this.sock!;
    try {
      await sock.sendMessage(this.toJid(to), { text: body });
      this.logger.log(`Text sent to ${to}`);
    } catch (error: any) {
      this.logger.error(`Failed to send text to ${to}`, error?.message ?? error);
      throw error;
    }
  }

  async sendButtons(
    to: string,
    bodyText: string,
    buttons: { id: string; title: string }[],
  ): Promise<void> {
    await this.waitForConnection();

    const sock = this.sock!;
    try {
      const numbered = buttons
        .map((btn, i) => `${i + 1}. ${btn.title}`)
        .join('\n');
      const full = `${bodyText}\n\n${numbered}`;
      await sock.sendMessage(this.toJid(to), { text: full });
      this.logger.log(`Buttons (text menu) sent to ${to}`);
    } catch (error: any) {
      this.logger.error(`Failed to send buttons to ${to}`, error?.message ?? error);
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
    await this.waitForConnection();

    const sock = this.sock!;
    try {
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
      await sock.sendMessage(this.toJid(to), { text });
      this.logger.log(`List (text menu) sent to ${to}`);
    } catch (error: any) {
      this.logger.error(`Failed to send list to ${to}`, error?.message ?? error);
      throw error;
    }
  }
}