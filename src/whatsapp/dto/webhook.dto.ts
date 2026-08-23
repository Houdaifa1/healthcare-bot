// Shapes for Meta's WhatsApp Cloud API webhook payload (POST /webhook).
// Plain interfaces, not class-validator DTOs — the payload arrives from an
// external, HMAC-signature-verified source (see WhatsAppController) rather
// than a client we control the shape of, so every field here is optional or
// defensively read with `?.` in whatsapp.service.ts instead of being
// validated at the boundary. This exists purely to replace `any`-typed
// walking of the payload with real type-checking.

export interface WebhookPayload {
  object?: string;
  entry?: WebhookEntry[];
}

export interface WebhookEntry {
  id?: string;
  changes?: WebhookChange[];
}

export interface WebhookChange {
  field?: string;
  value?: WebhookChangeValue;
}

export interface WebhookChangeValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: WebhookContact[];
  messages?: WebhookMessage[];
  statuses?: WebhookStatus[];
}

export interface WebhookContact {
  profile?: { name?: string };
  wa_id?: string;
}

export interface WebhookMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: 'text' | 'interactive' | 'image' | 'audio';
  text?: { body?: string };
  interactive?: {
    type?: 'button_reply' | 'list_reply';
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
}

export interface WebhookStatus {
  id?: string;
  status?: 'sent' | 'delivered' | 'read' | 'warning' | 'failed';
  timestamp?: string;
  recipient_id?: string;
  errors?: WebhookStatusError[];
}

export interface WebhookStatusError {
  code?: number;
  title?: string;
  message?: string;
  error_data?: unknown;
}
