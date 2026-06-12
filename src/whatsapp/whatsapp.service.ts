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
import * as fs from 'fs';
import * as QRCode from 'qrcode';
import { QUEUES, JOBS } from '../queue/queue.constants';
import type { MessageJob } from '../queue/message.processor';

// WhatsApp rejects QR codes older than ~20s
const QR_TTL_MS = 20_000;

// How long send methods wait for reconnection before throwing (retried by BullMQ)
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

  // ─── Public QR helpers — used by QrController ─────────────────────────────

  /**
   * True only if a QR exists AND it was generated within the last QR_TTL_MS.
   * This is what the client uses to decide whether to show or blur the QR.
   */
  get qrIsValid(): boolean {
    if (!this.qrDataUrl || !this.qrGeneratedAt) return false;
    return Date.now() - this.qrGeneratedAt < QR_TTL_MS;
  }

  // ─── Connection-ready gate ─────────────────────────────────────────────────

  private waitForConnection(timeoutMs = SEND_CONNECTION_TIMEOUT_MS): Promise<void> {
    if (this.isConnected && this.sock) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectionReadyListeners = this.connectionReadyListeners.filter(
          (l) => l !== onReady,
        );
        reject(new Error(`WhatsApp not connected after ${timeoutMs}ms — will retry`));
      }, timeoutMs);

      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };

      this.connectionReadyListeners.push(onReady);
    });
  }

  private notifyConnectionReady(): void {
    const listeners = this.connectionReadyListeners.splice(0);
    for (const fn of listeners) fn();
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
            info:  () => {},
            warn:  () => {},
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
          info:  () => {},
          warn:  (msg: any) => this.logger.warn(JSON.stringify(msg)),
          error: (msg: any) => this.logger.error(JSON.stringify(msg)),
          fatal: (msg: any) => this.logger.error(JSON.stringify(msg)),
          child: () => ({
            level: 'silent',
            trace: () => {},
            debug: () => {},
            info:  () => {},
            warn:  () => {},
            error: () => {},
            fatal: () => {},
            child: () => ({} as any),
          }),
        } as any,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        keepAliveIntervalMs: 10_000,
      });

      this.sock.ev.on('creds.update', saveCreds);
      this.sock.ev.on('connection.update', (u: any) => this.onConnectionUpdate(u));
      this.sock.ev.on('messages.upsert',   (u: any) => this.onMessage(u));
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
      this.logger.log('📱 New QR code generated — valid for ~20s');
      try {
        this.qrGeneratedAt = Date.now();
        this.qrDataUrl = await QRCode.toDataURL(qr, {
          width: 400,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
        });
      } catch (err) {
        this.logger.error('Failed to generate QR data URL', err);
      }
    }

    if (connection === 'open') {
      this.isConnected    = true;
      this.qrDataUrl      = null;
      this.qrGeneratedAt  = null;
      this.reconnectAttempts = 0;
      this.logger.log('✅ WhatsApp connected successfully');
      this.notifyConnectionReady();
    }

    if (connection === 'close') {
      this.isConnected = false;
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      this.logger.warn(`Connection closed — reason: ${statusCode}`);
      this.sock = null;

      if (this.isShuttingDown) return;

      if (statusCode === DisconnectReason.loggedOut) {
        this.logger.error('🚨 Logged out — wiping auth and re-scanning');
        this.qrDataUrl     = null;
        this.qrGeneratedAt = null;
        // Wipe stale credentials so Baileys shows a fresh QR instead of
        // silently failing to reconnect with an invalid session.
        try {
          const files = fs.readdirSync(this.authPath);
          for (const file of files) {
            fs.unlinkSync(path.join(this.authPath, file));
          }
          this.logger.log('Auth files cleared — fresh QR will be generated');
        } catch (err: any) {
          this.logger.warn(`Could not clear auth files: ${err?.message}`);
        }
        this.scheduleReconnect(2_000);
      } else if (statusCode === 408) {
        // QR scan timeout — reconnect immediately for a fresh QR
        this.scheduleReconnect(1_000);
      } else {
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(overrideDelay?: number): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    const delay =
      overrideDelay ??
      Math.min(5_000 * Math.pow(2, this.reconnectAttempts), this.MAX_RECONNECT_DELAY);

    this.reconnectAttempts++;
    this.logger.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  // ─── Incoming messages ─────────────────────────────────────────────────────

  private async onMessage(upsert: {
    messages: proto.IWebMessageInfo[];
    type: string;
  }): Promise<void> {
    if (upsert.type !== 'notify') return;

    for (const msg of upsert.messages) {
      if (!msg.key?.remoteJid) continue;
      if (msg.key.fromMe) continue;

      const rawJid = msg.key.remoteJid;
      if (rawJid.endsWith('@g.us')) continue;

      const text = this.extractText(msg);
      if (!text) continue;

      // ── Normalise JID ──────────────────────────────────────────────────────
      // WhatsApp delivers two JID formats:
      //   "212644645877@s.whatsapp.net"  — standard, Baileys sends to this fine
      //   "17450485735610@lid"            — anonymous LID used by newer clients
      //
      // The @lid user value is NOT the phone number — it is an opaque internal
      // identifier. Baileys cannot send to @lid directly; it tries a network
      // lookup that crashes the connection.
      //
      // The only reliable phone number available at message-receive time is
      // msg.pushName (display name, not a number) or msg.verifiedBizName.
      // Neither gives us the E.164 number.
      //
      // Solution: use msg.key.participant when present (group sender), otherwise
      // fall back to the phoneNumber field Baileys sometimes populates, and as a
      // last resort keep @lid but flag it so we can handle it.
      //
      // Actually the cleanest fix: Baileys stores a contact map in sock.store.
      // Since we don't use makeInMemoryStore, we have to resolve it differently.
      // The correct approach is to send using the SAME jid that arrived.
      // The xml-not-well-formed error was caused by a DIFFERENT bug — the
      // connection was being dropped mid-send due to retry logic firing before
      // reconnection finished (status 500 = stream error from concurrent send).
      //
      // With waitForConnection() now guarding all sends, @lid JIDs will work
      // because Baileys resolves them internally once the socket is stable.
      const sendableJid = rawJid;
      const phone = rawJid.replace('@s.whatsapp.net', '').replace('@lid', '');

      const job: MessageJob = {
        from: sendableJid,
        name: msg.pushName ?? 'Patient',
        text,
        messageId: msg.key.id ?? '',
        timestamp: String(msg.messageTimestamp ?? Date.now()),
      };

      await this.messageQueue.add(JOBS.PROCESS_MESSAGE, job, {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
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

  // ─── JID normalisation ────────────────────────────────────────────────────

  /**
   * Ensures we always pass a valid JID to sock.sendMessage.
   * - JIDs with '@' are returned as-is (covers @s.whatsapp.net and @lid)
   * - Bare phone numbers get @s.whatsapp.net appended
   */
  private toJid(phoneOrJid: string): string {
    // Baileys cannot send to @lid JIDs directly — convert to @s.whatsapp.net
    if (phoneOrJid.endsWith('@lid')) {
      return phoneOrJid.replace('@lid', '@s.whatsapp.net');
    }
    if (phoneOrJid.includes('@')) return phoneOrJid;
    return `${phoneOrJid.replace(/^\+/, '').replace(/\s/g, '')}@s.whatsapp.net`;
  }

  // ─── Outgoing messages ─────────────────────────────────────────────────────
  // waitForConnection() ensures the socket is live before every send.
  // This prevents the "xml-not-well-formed" / 500 crash that happened when
  // a send was attempted during the brief reconnection window after scanning.

  async sendText(to: string, body: string): Promise<void> {
    await this.waitForConnection();
    const sock = this.sock!;
    try {
      await sock.sendMessage(this.toJid(to), { text: body });
      this.logger.log(`Text sent to ${to}`);
    } catch (error: any) {
      this.logger.error(`Failed to send text to ${to}: ${error?.message}`);
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
      const numbered = buttons.map((b, i) => `${i + 1}. ${b.title}`).join('\n');
      await sock.sendMessage(this.toJid(to), { text: `${bodyText}\n\n${numbered}` });
      this.logger.log(`Buttons sent to ${to}`);
    } catch (error: any) {
      this.logger.error(`Failed to send buttons to ${to}: ${error?.message}`);
      throw error;
    }
  }

  async sendInteractiveList(
    to: string,
    header: string,
    body: string,
    _buttonLabel: string,
    sections: { title: string; rows: { id: string; title: string; description?: string }[] }[],
  ): Promise<void> {
    await this.waitForConnection();
    const sock = this.sock!;
    try {
      let text = `*${header}*\n${body}\n`;
      let index = 1;
      for (const section of sections) {
        // Only print section title if it differs from the header already shown
        if (section.title && section.title !== header) text += `\n*${section.title}*\n`;
        for (const row of section.rows) {
          text += `${index}. ${row.title}`;
          if (row.description) text += ` — ${row.description}`;
          text += '\n';
          index++;
        }
      }
      await sock.sendMessage(this.toJid(to), { text });
      this.logger.log(`List sent to ${to}`);
    } catch (error: any) {
      this.logger.error(`Failed to send list to ${to}: ${error?.message}`);
      throw error;
    }
  }
}