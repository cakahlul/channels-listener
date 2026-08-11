import { GoogleAuth } from "google-auth-library";
import type { Channel, InboundMessage, ReplySender, StreamingReplier, StreamingReplierFactory } from "../types/channel";
import type { Attachment } from "../core/claude-bridge";
import type { Config } from "../config";
import { logger } from "../utils/logger";
import { basename } from "path";

const CHAT_API = "https://chat.googleapis.com/v1";
const MAX_MESSAGE_LENGTH = 4096;
const STREAM_FLUSH_INTERVAL = 1500;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

interface ChatUser {
  name: string;
  displayName: string;
  type: "HUMAN" | "BOT";
}

interface ChatSpace {
  name: string;
  type: string;
  displayName?: string;
}

interface ChatMessage {
  name: string;
  text?: string;
  argumentText?: string;
  thread?: { name: string };
  sender: ChatUser;
  attachment?: Array<{
    name: string;
    contentName?: string;
    contentType?: string;
    attachmentDataRef?: { resourceName: string };
    source?: string;
  }>;
}

interface RawChatEvent {
  chat?: {
    user: ChatUser;
    messagePayload?: { space: ChatSpace; message: ChatMessage };
    addedToSpacePayload?: { space: ChatSpace };
    removedFromSpacePayload?: { space: ChatSpace };
  };
  type?: string;
  message?: ChatMessage;
  user?: ChatUser;
  space?: ChatSpace;
}

function splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit * 0.3) splitAt = remaining.lastIndexOf(" ", limit);
    if (splitAt < limit * 0.3) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

export class GoogleChatChannel implements Channel {
  readonly name = "google-chat";
  private auth: GoogleAuth;
  private port: number;
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(config: Config) {
    this.auth = new GoogleAuth({
      keyFile: config.googleChatCredentialsPath,
      scopes: ["https://www.googleapis.com/auth/chat.bot"],
    });
    this.port = config.googleChatWebhookPort;
  }

  private async token(): Promise<string> {
    const client = await this.auth.getClient();
    const res = await client.getAccessToken();
    if (!res.token) throw new Error("Failed to obtain Google access token");
    return res.token;
  }

  private async sendMessage(spaceName: string, text: string, threadName?: string): Promise<string> {
    const token = await this.token();
    const body: Record<string, unknown> = { text };
    let url = `${CHAT_API}/${spaceName}/messages`;
    if (threadName) {
      body.thread = { name: threadName };
      url += `?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`;
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Google Chat send failed: ${res.status} ${err}`);
    }
    const data = (await res.json()) as { name: string };
    return data.name;
  }

  private async uploadAttachment(spaceName: string, filePath: string, threadName?: string): Promise<void> {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return;

    const token = await this.token();
    const form = new FormData();
    form.append("attachment", file, basename(filePath));
    if (threadName) {
      form.append("thread.name", threadName);
    }

    const res = await fetch(`${CHAT_API}/${spaceName}/attachments:upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Google Chat attachment upload failed: ${res.status} ${err}`);
    }
  }

  private async updateMessage(messageName: string, text: string): Promise<void> {
    const token = await this.token();
    const url = `${CHAT_API}/${messageName}?updateMask=text`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const err = await res.text();
      logger.warn(`[google-chat] update failed: ${res.status} ${err}`);
    }
  }

  private async downloadAttachment(resourceName: string): Promise<{ data: Buffer; contentType: string }> {
    const token = await this.token();
    const url = `${CHAT_API}/media/${resourceName}?alt=media`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`attachment download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { data: buf, contentType: res.headers.get("content-type") || "application/octet-stream" };
  }

  private async downloadImageAttachments(msg: ChatMessage): Promise<Attachment[]> {
    if (!msg.attachment?.length) return [];
    const out: Attachment[] = [];
    for (const att of msg.attachment) {
      if (!att.contentType?.startsWith("image/")) continue;
      const resource = att.attachmentDataRef?.resourceName || att.name;
      try {
        const { data, contentType } = await this.downloadAttachment(resource);
        if (!SUPPORTED_IMAGE_TYPES.has(contentType)) continue;
        out.push({ data: data.toString("base64"), mediaType: contentType });
      } catch (err) {
        logger.warn(`[google-chat] attachment download error:`, err);
      }
    }
    return out;
  }

  private makeReplySender(spaceName: string, threadName?: string): ReplySender {
    return async (text: string, imageFiles?: string[]) => {
      if (text) {
        const chunks = splitMessage(text);
        for (const chunk of chunks) {
          try {
            await this.sendMessage(spaceName, chunk, threadName);
          } catch (err) {
            logger.error(`[google-chat] send error:`, err);
          }
        }
      }

      if (imageFiles?.length) {
        for (const filePath of imageFiles) {
          try {
            await this.uploadAttachment(spaceName, filePath, threadName);
          } catch (err) {
            logger.warn(`[google-chat] attachment upload error:`, err);
            try {
              await this.sendMessage(spaceName, `Image tersedia di: ${filePath}`, threadName);
            } catch (sendErr) {
              logger.error(`[google-chat] fallback image path send error:`, sendErr);
            }
          }
        }
      }
    };
  }

  private makeStreamingReplier(spaceName: string, threadName?: string): StreamingReplier {
    let buffer = "";
    let currentMessageName: string | null = null;
    let sentText = "";
    let timer: ReturnType<typeof setInterval> | null = null;
    let flushPromise: Promise<void> = Promise.resolve();

    const doFlush = async () => {
      if (buffer === sentText && currentMessageName) return;
      const text = buffer;
      try {
        if (!currentMessageName) {
          const chunk = text.slice(0, MAX_MESSAGE_LENGTH);
          currentMessageName = await this.sendMessage(spaceName, chunk, threadName);
          sentText = chunk;
        } else if (text.length <= MAX_MESSAGE_LENGTH) {
          await this.updateMessage(currentMessageName, text);
          sentText = text;
        } else {
          const finalText = text.slice(0, MAX_MESSAGE_LENGTH);
          await this.updateMessage(currentMessageName, finalText);
          sentText = finalText;
          const remainder = text.slice(MAX_MESSAGE_LENGTH);
          buffer = remainder;
          currentMessageName = await this.sendMessage(spaceName, remainder.slice(0, MAX_MESSAGE_LENGTH), threadName);
          sentText = remainder.slice(0, MAX_MESSAGE_LENGTH);
        }
      } catch (err) {
        logger.warn(`[google-chat] stream flush error:`, err);
      }
    };

    return {
      onDelta(delta: string) {
        buffer += delta;
        if (!timer) {
          timer = setInterval(() => {
            flushPromise = flushPromise.then(doFlush);
          }, STREAM_FLUSH_INTERVAL);
          flushPromise = flushPromise.then(doFlush);
        }
      },
      async flush() {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        await flushPromise;
        await doFlush();
      },
    };
  }

  async start(
    onMessage: (msg: InboundMessage, reply: ReplySender, createStreamer?: StreamingReplierFactory) => Promise<void>,
  ): Promise<void> {
    this.server = Bun.serve({
      port: this.port,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/health") {
          return Response.json({ status: "ok" });
        }
        if (req.method !== "POST") return new Response("Not Found", { status: 404 });

        let raw: RawChatEvent;
        try {
          raw = (await req.json()) as RawChatEvent;
        } catch {
          return Response.json({ text: "Invalid body" }, { status: 400 });
        }

        const event = this.normalize(raw);
        if (event.type === "ADDED_TO_SPACE") {
          return Response.json({ text: "Hi! Mention me or DM me and I'll process via the configured agent." });
        }
        if (event.type !== "MESSAGE" || !event.message) {
          return Response.json({});
        }

        const message = event.message;
        const text = (message.argumentText || message.text || "").trim();
        const spaceName = event.space.name;
        const threadName = message.thread?.name;
        const attachments = await this.downloadImageAttachments(message);

        if (!text && attachments.length === 0) {
          return Response.json({ text: "Send text or an image." });
        }

        const sessionKey = `${spaceName}::${threadName || "main"}`;
        const inbound: InboundMessage = {
          context: {
            platform: "google-chat",
            sessionKey,
            channelId: spaceName,
            userId: event.user.name,
            userName: event.user.displayName,
          },
          text: text || "(image attached)",
          attachments,
        };

        const reply = this.makeReplySender(spaceName, threadName);
        const streamerFactory: StreamingReplierFactory = () => this.makeStreamingReplier(spaceName, threadName);

        // Process async — return empty 200 immediately so Google Chat doesn't time out
        onMessage(inbound, reply, streamerFactory).catch((err) => {
          logger.error(`[google-chat] handler error:`, err);
        });

        return Response.json({});
      },
    });

    logger.info(`Google Chat webhook listening on port ${this.server.port}`);
  }

  private normalize(raw: RawChatEvent): { type: string; user: ChatUser; space: ChatSpace; message?: ChatMessage } {
    if (raw.chat) {
      const c = raw.chat;
      if (c.messagePayload) {
        return { type: "MESSAGE", user: c.user, space: c.messagePayload.space, message: c.messagePayload.message };
      }
      if (c.addedToSpacePayload) {
        return { type: "ADDED_TO_SPACE", user: c.user, space: c.addedToSpacePayload.space };
      }
      if (c.removedFromSpacePayload) {
        return { type: "REMOVED_FROM_SPACE", user: c.user, space: c.removedFromSpacePayload.space };
      }
      return { type: "UNKNOWN", user: c.user, space: { name: "", type: "DM" } };
    }
    return {
      type: raw.type || "UNKNOWN",
      user: raw.user || { name: "", displayName: "Unknown", type: "HUMAN" },
      space: raw.space || { name: "", type: "DM" },
      message: raw.message,
    };
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.stop();
      this.server = null;
      logger.info("Google Chat webhook stopped");
    }
  }
}
