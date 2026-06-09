import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

const META_TEST_NUMBERS = new Set(['16315551181', '15550555555']);

@Injectable()
export class WhatsAppService implements OnModuleInit {
  private readonly logger = new Logger(WhatsAppService.name);
  private client: AxiosInstance;
  private phoneNumberId: string;
  private isConfigured = false;

  constructor(private configService: ConfigService) {
    const accessToken = this.configService.get<string>('whatsapp.accessToken');
    const phoneNumberId = this.configService.get<string>('whatsapp.phoneNumberId');

    if (!accessToken || !phoneNumberId) {
      this.logger.warn('META credentials not set — WhatsApp sending disabled');
      return;
    }

    this.phoneNumberId = phoneNumberId;
    this.isConfigured = true;

    this.client = axios.create({
      baseURL: 'https://graph.facebook.com/v20.0',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
  }

  onModuleInit() {
    this.logger.log(
      this.isConfigured
        ? 'WhatsApp service initialized and ready'
        : 'WhatsApp service initialized in LOCAL MODE — messages will be logged only',
    );
  }

  private isTestNumber(to: string): boolean {
    return META_TEST_NUMBERS.has(to);
  }

  async sendText(to: string, body: string): Promise<void> {
    if (!this.isConfigured) {
      this.logger.log(`[LOCAL MODE] sendText → ${to}: ${body}`);
      return;
    }
    if (this.isTestNumber(to)) {
      this.logger.log(`[TEST MODE] sendText → ${to}: ${body}`);
      return;
    }
    try {
      await this.client.post(`/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body },
      });
      this.logger.log(`Text sent to ${to}`);
    } catch (error: unknown) {
      const axiosError = error as { response?: { data?: unknown } };
      this.logger.error(`Failed to send text to ${to}`, axiosError?.response?.data);
      throw error;
    }
  }

  async sendButtons(
    to: string,
    bodyText: string,
    buttons: { id: string; title: string }[],
  ): Promise<void> {
    if (!this.isConfigured) {
      this.logger.log(`[LOCAL MODE] sendButtons → ${to}: ${bodyText}`);
      return;
    }
    if (this.isTestNumber(to)) {
      this.logger.log(`[TEST MODE] sendButtons → ${to}: ${bodyText} | ${buttons.map((b) => b.title).join(', ')}`);
      return;
    }
    try {
      await this.client.post(`/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: bodyText },
          action: {
            buttons: buttons.map((btn) => ({
              type: 'reply',
              reply: { id: btn.id, title: btn.title },
            })),
          },
        },
      });
      this.logger.log(`Buttons sent to ${to}`);
    } catch (error: unknown) {
      const axiosError = error as { response?: { data?: unknown } };
      this.logger.error(`Failed to send buttons to ${to}`, axiosError?.response?.data);
      throw error;
    }
  }

  async sendInteractiveList(
    to: string,
    header: string,
    body: string,
    buttonLabel: string,
    sections: {
      title: string;
      rows: { id: string; title: string; description?: string }[];
    }[],
  ): Promise<void> {
    if (!this.isConfigured) {
      this.logger.log(`[LOCAL MODE] sendList → ${to}: ${header}`);
      return;
    }
    if (this.isTestNumber(to)) {
      this.logger.log(`[TEST MODE] sendList → ${to}: ${header}`);
      return;
    }
    try {
      await this.client.post(`/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          header: { type: 'text', text: header },
          body: { text: body },
          action: { button: buttonLabel, sections },
        },
      });
      this.logger.log(`List sent to ${to}`);
    } catch (error: unknown) {
      const axiosError = error as { response?: { data?: unknown } };
      this.logger.error(`Failed to send list to ${to}`, axiosError?.response?.data);
      throw error;
    }
  }
}
