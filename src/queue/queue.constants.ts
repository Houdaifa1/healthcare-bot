export const QUEUES = {
  MESSAGES: 'messages',
  CAMPAIGN_OUTBOUND: 'campaign-outbound',
} as const;

export const JOBS = {
  PROCESS_MESSAGE: 'process_message',
  SEND_REMINDER: 'send_reminder',
  NOTIFY_BOSS: 'notify_boss',
  SEND_CAMPAIGN_OUTBOUND: 'send_campaign_outbound', // fires opening message to one patient
  SEND_CAMPAIGN_REMINDER: 'send_campaign_reminder', // fires reminder to one patient
} as const;
