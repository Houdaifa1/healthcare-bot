export class WebhookDto {
  object: string;
  entry: EntryDto[];
}

export class EntryDto {
  id: string;
  changes: ChangeDto[];
}

export class ChangeDto {
  value: ChangeValueDto;
  field: string;
}

export class ChangeValueDto {
  messaging_product: string;
  metadata: MetadataDto;
  contacts?: ContactDto[];
  messages?: WhatsAppMessageDto[];
  statuses?: StatusDto[];
}

export class MetadataDto {
  display_phone_number: string;
  phone_number_id: string;
}

export class ContactDto {
  profile: { name: string };
  wa_id: string;
}

export class WhatsAppMessageDto {
  from: string;
  id: string;
  timestamp: string;
  type: 'text' | 'interactive' | 'image' | 'audio';
  text?: { body: string };
  interactive?: {
    type: 'button_reply' | 'list_reply';
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
}

export class StatusDto {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id: string;
}