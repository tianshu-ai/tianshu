// Capability-side type for `host.messageQueue`.
//
// Lets plugins push messages into a user's pending message queue
// (the same queue that holds follow-up messages typed while the
// agent is mid-turn). Messages appear in the webchat queue UI
// and are drained to the agent in FIFO order.
//
// Primary consumer: messenger plugin — inbound wechat messages
// go into the queue instead of session-inbox system_notes, so
// the user can see, edit, reorder, or dismiss them before the
// agent processes them.

/** Source metadata attached to a queue entry so the UI can render
 *  provenance (e.g. "via WeChat · 张三"). */
export interface QueueMessageSource {
  /** Channel type that produced this message. */
  type: "wechat" | "a2a" | "feishu" | "telegram" | "system";
  /** Human-readable sender name. */
  contactName?: string;
  /** Stable contact id in the messenger plugin's DB. */
  contactId?: string;
}

export interface QueueMessage {
  /** The text content to show in the queue and eventually send to the agent. */
  content: string;
  /** Where this message came from. Omit for plain user follow-ups. */
  source?: QueueMessageSource;
}

export interface MessageQueueCapability {
  /**
   * Push a message into the user's pending queue and trigger the
   * agent to process it.
   *
   * The message appears in the webchat queue UI immediately (via
   * WS broadcast) with source metadata. The agent is triggered
   * via session-inbox so it works even without an active WS
   * connection.
   *
   * Returns the queue entry id.
   */
  enqueue(userId: string, message: QueueMessage): Promise<string>;
}
