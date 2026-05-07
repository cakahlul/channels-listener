import type { Attachment } from "../core/claude-bridge";

/** Uniquely identifies a conversation context across any platform. */
export interface ChannelContext {
  platform: string;
  /** Key used for session lookup. For Discord guild: threadId. For DMs: dmChannelId. */
  sessionKey: string;
  /** Stable channel ID for grouping (e.g. schedules). For Discord: parent channel ID. For DMs: same as sessionKey. */
  channelId: string;
  userId: string;
  userName: string;
}

/** An inbound message from any platform. */
export interface InboundMessage {
  context: ChannelContext;
  text: string;
  attachments?: Attachment[];
  /** User mentions in the message (platform-specific). */
  mentions?: Array<{ id: string; username: string }>;
}

/** Sends a reply back through the originating platform. */
export type ReplySender = (text: string, imageFiles?: string[]) => Promise<void>;

/** Handles streaming text deltas for real-time message updates. */
export interface StreamingReplier {
  onDelta: (textDelta: string) => void;
  flush: () => Promise<void>;
}

/** Creates a StreamingReplier for a given channel context. */
export type StreamingReplierFactory = () => StreamingReplier;

/** Every chat platform adapter implements this interface. */
export interface Channel {
  readonly name: string;
  start(onMessage: (msg: InboundMessage, reply: ReplySender, createStreamer?: StreamingReplierFactory) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}
