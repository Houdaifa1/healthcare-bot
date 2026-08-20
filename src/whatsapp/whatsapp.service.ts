import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DeliveryStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QUEUES, JOBS } from '../queue/queue.constants';
import type { MessageJob } from '../queue/message.processor';

// ─── Meta Cloud API base URL ───────────────────────────────────────────────
// All outbound requests go to:
//   POST https://graph.facebook.com/{apiVersion}/{phoneNumberId}/messages
//   Authorization: Bearer {accessToken}

interface MetaSendError {
  message?: string;
  type?: string;
  code?: number;
  error_data?: unknown;
  fbtrace_id?: string;
}

interface MetaSendResponse {
  messaging_product?: string;
  contacts?: { input?: string; wa_id?: string }[];
  messages?: {
    id?: string;
    errors?: { code: number; title?: string; message?: string; error_data?: unknown }[];
  }[];
  error?: MetaSendError;
}

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  private readonly accessToken:   string;
  private readonly phoneNumberId: string;
  private readonly apiVersion:    string;
  private readonly baseUrl:       string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
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
   * Delivery statuses (sent/delivered/read/failed) are recorded against the
   * corresponding CampaignPatient so the dashboard reflects true delivery state.
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

        // ── Delivery statuses ─────────────────────────────────────────────
        // Meta reports outbound delivery state (sent/delivered/read/failed) via
        // the same webhook, keyed by the outbound message id (wamid). We must
        // record these so the dashboard reflects true delivery, not just "job
        // dispatched". Previously these were dropped entirely.
        const statuses: any[] = value?.statuses ?? [];
        for (const status of statuses) {
          await this.handleDeliveryStatus(status);
        }
      }
    }
  }

  // ─── Delivery status tracking ──────────────────────────────────────────────

  private async handleDeliveryStatus(status: any): Promise<void> {
    const wamId: string | undefined = status?.id;
    const metaStatus: string | undefined = status?.status;
    if (!wamId || !metaStatus) return;

    const deliveryStatus = this.mapDeliveryStatus(metaStatus);
    if (!deliveryStatus) {
      this.logger.warn(`Unrecognised Meta delivery status "${metaStatus}" for wamid ${wamId} — ignoring`);
      return;
    }

    try {
      const updated = await this.prisma.campaignPatient.updateMany({
        where: { outboundMessageId: wamId },
        data:  { deliveryStatus },
      });

      if (updated.count > 0) {
        this.logger.log(`Delivery status ${deliveryStatus} recorded for wamid ${wamId}`);
      } else if (deliveryStatus === DeliveryStatus.FAILED) {
        // A FAILED status for an untracked wamid is worth surfacing — it means
        // Meta rejected a message we did not (or no longer) track.
        this.logger.warn(
          `Received FAILED delivery status for untracked wamid ${wamId}: ${JSON.stringify(status.errors ?? status)}`,
        );
      }

      // Surface the actual Meta error code/title so failed deliveries are
      // diagnosable (e.g. 131026 "Message undeliverable" vs 132001 "template not
      // found") instead of just a bare "FAILED".
      if (deliveryStatus === DeliveryStatus.FAILED && Array.isArray(status.errors) && status.errors.length > 0) {
        const errs = status.errors.map(
          (e: any) => `code=${e?.code ?? 'n/a'} (${e?.title ?? 'unknown'}): ${e?.message ?? ''}`,
        );
        this.logger.warn(`Delivery FAILED for wamid ${wamId} — ${errs.join('; ')}`);
      }
    } catch (err: any) {
      this.logger.error(`Failed to persist delivery status for wamid ${wamId}: ${err.message}`);
    }
  }

  private mapDeliveryStatus(status: string): DeliveryStatus | null {
    switch (status) {
      case 'sent':      return DeliveryStatus.SENT;
      case 'delivered': return DeliveryStatus.DELIVERED;
      case 'read':      return DeliveryStatus.READ;
      case 'warning':   return DeliveryStatus.WARNING;
      case 'failed':    return DeliveryStatus.FAILED;
      default:          return null;
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
   * Sends a plain text message. Returns the Meta message id (wamid).
   */
  async sendText(to: string, body: string): Promise<string> {
    const wamId = await this.sendRaw({
      messaging_product: 'whatsapp',
      recipient_type:    'individual',
      to:                this.normalisePhone(to),
      type:              'text',
      text:              { preview_url: false, body },
    });
    this.logger.log(`Text sent to ${to}`);
    return wamId;
  }

  /**
   * Sends an approved Meta template message.
   * Used for the campaign opening message so new contacts (24h window not open)
   * can receive it without being blocked by Meta.
   *
   * @param to           - Recipient phone in any format (normalised internally)
   * @param templateName - Exact name of the approved template in Meta Business Manager
   * @param languageCode - BCP-47 code matching the approved template language, e.g. 'fr' or 'en'
   * @param components   - Array of component objects (body parameters, header, etc.)
   *
   * Example for patient_followup template with {{1}} and {{2}}:
   *   components: [{
   *     type: 'body',
   *     parameters: [
   *       { type: 'text', text: 'Mohammed' },
   *       { type: 'text', text: '15/06/2025' },
   *     ],
   *   }]
   */
  async sendTemplate(
    to:           string,
    templateName: string,
    languageCode: string,
    components:   Record<string, unknown>[],
  ): Promise<string> {
    const wamId = await this.sendRaw({
      messaging_product: 'whatsapp',
      recipient_type:    'individual',
      to:                this.normalisePhone(to),
      type:              'template',
      template: {
        name:     templateName,
        language: { code: languageCode },
        components,
      },
    });
    this.logger.log(`Template "${templateName}" sent to ${to}`);
    return wamId;
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

    const safeButtons = buttons.slice(0, 3).map((b) => {
      // BUG 15: Log warning when button title is truncated
      if (b.title.length > 20) {
        this.logger.warn(
          `Button "${b.id}" title "${b.title}" truncated. Fix value in DB.`,
        );
      }
      return {
        type:  'reply',
        reply: {
          id:    b.id.slice(0, 256),    // Meta limit: 256 chars
          title: b.title.slice(0, 20),  // Meta limit: 20 chars
        },
      };
    });

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

  /**
   * Sends a payload to the Meta Cloud API and returns the outbound message id
   * (wamid) on success. Throws on any failure.
   *
   * IMPORTANT: Meta frequently returns HTTP 200 even when a message is NOT
   * accepted — the real error is embedded in the JSON body either as a
   * top-level `error` object or as `messages[0].errors[]`. Only checking the
   * HTTP status (as the previous implementation did) made a rejected send look
   * successful, so the dashboard optimistically marked patients as CONTACTED
   * even though nothing ever reached their device.
   */
  private async sendRaw(payload: Record<string, unknown>): Promise<string> {
    const response = await fetch(this.baseUrl, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify(payload),
    });

    let responseBody = '';
    try {
      responseBody = JSON.stringify(await response.json());
    } catch {
      responseBody = await response.text().catch(() => '');
    }

    if (!response.ok) {
      const msg = `Meta API error ${response.status}: ${responseBody}`;
      this.logger.error(msg);
      throw new Error(msg);
    }

    // Parse the accepted body and surface any per-message / top-level error
    // that Meta reported alongside an HTTP 200.
    let parsed: MetaSendResponse | null = null;
    try {
      parsed = JSON.parse(responseBody) as MetaSendResponse;
    } catch {
      parsed = null;
    }

    if (parsed?.error) {
      const err = parsed.error;
      const msg =
        `Meta rejected message (code ${err.code ?? 'n/a'}): ${err.message ?? JSON.stringify(err)}`;
      this.logger.error(msg);
      throw new Error(msg);
    }

    const perMessageErrors = parsed?.messages?.find(
      (m) => Array.isArray(m.errors) && m.errors.length > 0,
    )?.errors;
    if (perMessageErrors) {
      const msg = `Meta rejected message: ${JSON.stringify(perMessageErrors)}`;
      this.logger.error(msg);
      throw new Error(msg);
    }

    const wamId: string = parsed?.messages?.[0]?.id ?? '';
    if (!wamId) {
      this.logger.warn(
        `Meta accepted message but returned no message id: ${responseBody}`,
      );
    }

    this.logger.log(`Meta API response: ${responseBody}`);
    return wamId;
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