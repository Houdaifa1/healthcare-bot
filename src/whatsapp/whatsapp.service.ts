import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUES, JOBS } from '../queue/queue.constants';
import type { MessageJob } from '../queue/message.processor';

// ─── Meta Cloud API base URL ───────────────────────────────────────────────
// All outbound requests go to:
//   POST https://graph.facebook.com/{apiVersion}/{phoneNumberId}/messages
//   Authorization: Bearer {accessToken}

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  private readonly accessToken:   string;
  private readonly phoneNumberId: string;
  private readonly apiVersion:    string;
  private readonly baseUrl:       string;

  constructor(
    private readonly configService: ConfigService,
    @InjectQueue(QUEUES.MESSAGES) private readonly messageQueue: Queue,
  ) {
    const accessToken   = this.configService.get<string>('whatsapp.accessToken');
    const phoneNumberId = this.configService.get<string>('whatsapp.phoneNumberId');
    const apiVersion    = this.configService.get<string>('whatsapp.apiVersion') ?? 'v20.0';

    if (!accessToken)   throw new Error('META_ACCESS_TOKEN is not set');
    if (!phoneNumberId) throw new Error('META_PHONE_NUMBER_ID is not set');

    this.accessToken   = accessToken;
    this.phoneNumberId = phoneNumberId;
    this.apiVersion    = apiVersion;
    this.baseUrl       = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
  }

  // ─── Incoming webhook entry point — called by WhatsAppController ──────────

  /**
   * Parses a verified webhook payload and enqueues one job per inbound message.
   * Statuses (delivered, read, failed) are acknowledged and ignored.
   */
  async handleIncomingWebhook(body: any): Promise<void> {
    const entries: any[] = body?.entry ?? [];

    for (const entry of entries) {
      const changes: any[] = entry?.changes ?? [];

      for (const change of changes) {
        if (change?.field !== 'messages') continue;

        const value = change?.value;
        if (!value) continue;

        // ── Inbound messages ──────────────────────────────────────────────
        const messages: any[] = value?.messages ?? [];
        const contacts: any[] = value?.contacts ?? [];

        for (const msg of messages) {
          // Only process inbound text and interactive replies
          const type: string = msg?.type;
          if (!['text', 'interactive'].includes(type)) continue;

          const from: string = msg?.from; // E.164 without '+', e.g. "212644645877"
          if (!from) continue;

          const text = this.extractText(msg);
          if (!text) continue;

          // Resolve display name from contacts array (best-effort)
          const contact = contacts.find((c: any) => c?.wa_id === from);
          const name: string = contact?.profile?.name ?? 'Patient';

          const job: MessageJob = {
            from,
            name,
            text,
            messageId:  msg?.id ?? '',
            timestamp:  msg?.timestamp ?? String(Math.floor(Date.now() / 1000)),
          };

          await this.messageQueue.add(JOBS.PROCESS_MESSAGE, job, {
            attempts:         5,
            backoff:          { type: 'exponential', delay: 5_000 },
            removeOnComplete: 100,
            removeOnFail:     50,
          });

          this.logger.log(`Job queued for ${from} (${name}): "${text}"`);
        }
      }
    }
  }

  // ─── Text extraction ───────────────────────────────────────────────────────

  private extractText(msg: any): string | null {
    if (msg.type === 'text') {
      return msg?.text?.body?.trim() ?? null;
    }

    if (msg.type === 'interactive') {
      const interactive = msg?.interactive;
      // button_reply: user tapped a quick-reply button
      if (interactive?.type === 'button_reply') {
        // Use the button ID so handlers can match by id (e.g. "lang_fr")
        return interactive.button_reply?.id?.trim() ?? null;
      }
      // list_reply: user selected a row from a list message
      if (interactive?.type === 'list_reply') {
        return interactive.list_reply?.id?.trim() ?? null;
      }
    }

    return null;
  }

  // ─── Outbound helpers — all go through sendRaw() ──────────────────────────

  /**
   * Sends a plain text message.
   */
  async sendText(to: string, body: string): Promise<void> {
    await this.sendRaw({
      messaging_product: 'whatsapp',
      recipient_type:    'individual',
      to:                this.normalisePhone(to),
      type:              'text',
      text:              { preview_url: false, body },
    });
    this.logger.log(`Text sent to ${to}`);
  }

  /**
   * Sends up to 3 quick-reply buttons.
   * Meta only supports 1–3 buttons per message.
   * If more than 3 are passed, excess buttons are silently dropped and a
   * warning is logged — callers should never pass more than 3.
   */
  async sendButtons(
    to:       string,
    bodyText: string,
    buttons:  { id: string; title: string }[],
  ): Promise<void> {
    if (buttons.length === 0) {
      // Degrade gracefully to plain text
      await this.sendText(to, bodyText);
      return;
    }

    if (buttons.length > 3) {
      this.logger.warn(
        `sendButtons called with ${buttons.length} buttons for ${to} — Meta limit is 3. Truncating.`,
      );
    }

    const safeButtons = buttons.slice(0, 3).map((b) => ({
      type:  'reply',
      reply: {
        id:    b.id.slice(0, 256),    // Meta limit: 256 chars
        title: b.title.slice(0, 20),  // Meta limit: 20 chars
      },
    }));

    await this.sendRaw({
      messaging_product: 'whatsapp',
      recipient_type:    'individual',
      to:                this.normalisePhone(to),
      type:              'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText.slice(0, 1024) }, // Meta body limit: 1024
        action: { buttons: safeButtons },
      },
    });
    this.logger.log(`Buttons sent to ${to}`);
  }

  /**
   * Sends a list message (single section, up to 10 rows per section).
   * Meta limits: button label ≤ 20 chars, row title ≤ 24 chars,
   * row description ≤ 72 chars, max 10 rows per section, max 10 sections.
   */
  async sendInteractiveList(
    to:          string,
    header:      string,
    body:        string,
    buttonLabel: string,
    sections:    { title: string; rows: { id: string; title: string; description?: string }[] }[],
  ): Promise<void> {
    if (sections.length === 0 || sections.every((s) => s.rows.length === 0)) {
      await this.sendText(to, `${header}\n\n${body}`);
      return;
    }

    const safeSections = sections.slice(0, 10).map((s) => ({
      title: s.title.slice(0, 24),
      rows:  s.rows.slice(0, 10).map((r) => ({
        id:          r.id.slice(0, 200),
        title:       r.title.slice(0, 24),
        description: r.description ? r.description.slice(0, 72) : undefined,
      })),
    }));

    await this.sendRaw({
      messaging_product: 'whatsapp',
      recipient_type:    'individual',
      to:                this.normalisePhone(to),
      type:              'interactive',
      interactive: {
        type:   'list',
        header: { type: 'text', text: header.slice(0, 60) },
        body:   { text: body.slice(0, 1024) },
        action: {
          button:   buttonLabel.slice(0, 20),
          sections: safeSections,
        },
      },
    });
    this.logger.log(`List sent to ${to}`);
  }

  // ─── Core HTTP sender ──────────────────────────────────────────────────────

  private async sendRaw(payload: Record<string, unknown>): Promise<void> {
    const response = await fetch(this.baseUrl, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      let errorBody = '';
      try {
        errorBody = JSON.stringify(await response.json());
      } catch {
        errorBody = await response.text().catch(() => '');
      }
      const msg = `Meta API error ${response.status}: ${errorBody}`;
      this.logger.error(msg);
      throw new Error(msg);
    }
  }

  // ─── Phone normalisation ───────────────────────────────────────────────────

  /**
   * Meta expects E.164 without the '+' sign, e.g. "212644645877".
   * Strips leading '+' and any spaces. Does not add country code.
   */
  private normalisePhone(phone: string): string {
    return phone.replace(/^\+/, '').replace(/\s/g, '');
  }
}