/** Uniquely identifies a conversation context across any platform. */
export interface ChannelContext {
  platform: string;
  /** Key used for session lookup. For Discord guild: threadId. For DMs: dmChannelId. */
  sessionKey: string;
  userId: string;
  userName: string;
}

/** An inbound message from any platform. */
export interface InboundMessage {
  context: ChannelContext;
  text: string;
  attachments?: string[];
}

/** Sends a reply back through the originating platform. */
export type ReplySender = (text: string) => Promise<void>;

/** Every chat platform adapter implements this interface. */
export interface Channel {
  readonly name: string;
  start(onMessage: (msg: InboundMessage, reply: ReplySender) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}
