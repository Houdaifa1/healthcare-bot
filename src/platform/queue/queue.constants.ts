export const QUEUES = {
  MESSAGES:         'messages',
  CAMPAIGN_OUTBOUND: 'campaign-outbound',
} as const;

export const JOBS = {
  PROCESS_MESSAGE:       'process_message',
  SEND_CAMPAIGN_OUTBOUND: 'send_campaign_outbound', // fires opening message to one patient
} as const;