/**
 * Capability flags an adapter declares so the server/scheduler can make
 * informed choices (whether to poll, whether to listen for webhooks, etc.).
 */
export interface AdapterCapabilities {
  /** Can fetch only changed items since a cursor. */
  supportsIncrementalSync: boolean;
  /** Can receive push notifications from the source. */
  supportsWebhooks: boolean;
  /** Item content may include attachments worth ingesting. */
  supportsAttachments: boolean;
  /** Items may have comment threads. */
  supportsComments: boolean;
  /** Supports real-time streaming (e.g., websocket). */
  supportsRealTime: boolean;
}
