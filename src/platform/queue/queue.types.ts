// Queue payload contracts. These live with the queue infrastructure, not with
// either side of the wire: the producer (integrations/whatsapp, layer 2) and
// the consumer (conversation/inbound, layer 4) both import them downward from
// platform, instead of the producer reaching up into the consumer's module.

/** Payload of a JOBS.PROCESS_MESSAGE job on the QUEUES.MESSAGES queue. */
export interface MessageJob {
  from:      string;
  name:      string;
  text:      string;
  messageId: string;
  timestamp: string;
}
