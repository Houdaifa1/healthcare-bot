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

const QR_TTL_MS = 18_000;

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

  // ─── Public helpers ───────────────────────────────────────────────────────
  get qrIsValid(): boolean {
    if (!this.qrGeneratedAt || !this.qrDataUrl) return false;
    return Date.now() - this.qrGeneratedAt < QR_TTL_MS;
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
            trace: () => {},
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {},
            fatal: () => {},
            child: () => ({} as any),
          } as any),
        },
        printQRInTerminal: true,
        logger: {
          level: 'silent',
          trace: () => {},
          debug: () => {},
          info: () => {},
          warn: (msg: any) => this.logger.warn(JSON.stringify(msg)),
          error: (msg: any) => this.logger.error(JSON.stringify(msg)),
          fatal: (msg: any) => this.logger.error(JSON.stringify(msg)),
          child: () => ({
            level: 'silent',
            trace: () => {},
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {},
            fatal: () => {},
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
        this.logger.log(
          `QR ready — visit https://scan.houdaifa.dev?token=<QR_TOKEN>`,
        );
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
        // Always reconnect on logout — will surface a new QR
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

      let jid = msg.key.remoteJid;
      if (jid.endsWith('@g.us')) continue;
      if (jid === 'status@broadcast') continue;

      // ─── Resolve Linked Device ID (LID) to real phone JID ─────────────
      if (jid.endsWith('@lid') && this.sock) {
        try {
          let pn: string | null = null;

          // Attempt 1: via lidMapping (present in some Baileys builds)
          if (typeof (this.sock as any).lidMapping?.getPNForLID === 'function') {
            pn = await (this.sock as any).lidMapping.getPNForLID(jid);
          }

          // Attempt 2: direct method (added in Baileys 6.6.0+)
          if (!pn && typeof (this.sock as any).getPNFromLID === 'function') {
            pn = await (this.sock as any).getPNFromLID(jid);
          }

          if (pn) {
            this.logger.log(`Resolved LID ${jid} → ${pn}`);
            jid = pn;
          } else {
            this.logger.warn(`Could not resolve LID ${jid} – ignoring message`);
            continue; // skip this message – replying to an LID will disconnect us
          }
        } catch (err: any) {
          this.logger.error(`Error resolving LID ${jid}: ${err.message}`);
          continue; // skip
        }
      }

      // jid is now guaranteed to be a real phone JID (e.g. 212644645877@s.whatsapp.net)
      if (!jid.endsWith('@s.whatsapp.net')) {
        this.logger.warn(`Unexpected JID format: ${jid} – ignoring`);
        continue;
      }

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
      this.logger.warn(
        `sendButtons — not connected, dropping message to ${to}`,
      );
      return;
    }
    try {
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
      this.logger.warn(
        `sendInteractiveList — not connected, dropping message to ${to}`,
      );
      return;
    }
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
      await this.sock.sendMessage(this.jid(to), { text });
      this.logger.log(`List (text menu) sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send list to ${to}`, error);
      throw error;
    }
  }
}