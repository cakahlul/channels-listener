import {
  AttachmentBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import type { Channel, InboundMessage, ReplySender } from "../types/channel";
import type { Attachment } from "../core/claude-bridge";
import type { Config } from "../config";
import { logger } from "../utils/logger";
import { basename } from "path";

const MAX_MESSAGE_LENGTH = 2000;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Split a long message into chunks. */
function splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let splitAt = limit;
    const lastNewline = remaining.lastIndexOf("\n", limit);
    if (lastNewline > limit * 0.5) {
      splitAt = lastNewline + 1;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

/** Strip bot mention from message content. */
function stripMention(content: string, botId: string): string {
  return content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

/** Check if a channel is a thread. */
function isThread(type: ChannelType): boolean {
  return (
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread ||
    type === ChannelType.AnnouncementThread
  );
}

/** Download Discord attachments as base64 Attachment objects. */
async function downloadImageAttachments(message: Message): Promise<Attachment[]> {
  const images: Attachment[] = [];

  for (const att of message.attachments.values()) {
    const contentType = att.contentType ?? "";
    if (!SUPPORTED_IMAGE_TYPES.has(contentType)) continue;

    try {
      const res = await fetch(att.url);
      if (!res.ok) continue;
      const buffer = await res.arrayBuffer();
      const data = Buffer.from(buffer).toString("base64");
      images.push({ data, mediaType: contentType });
      logger.debug(`[discord] Downloaded attachment ${att.name} (${contentType}, ${Math.round(buffer.byteLength / 1024)}KB)`);
    } catch (err) {
      logger.warn(`[discord] Failed to download attachment ${att.name}:`, err);
    }
  }

  return images;
}

/** Download image attachments from raw DM event data. */
async function downloadRawAttachments(rawAttachments: any[]): Promise<Attachment[]> {
  if (!rawAttachments?.length) return [];

  const images: Attachment[] = [];
  for (const att of rawAttachments) {
    const contentType: string = att.content_type ?? "";
    if (!SUPPORTED_IMAGE_TYPES.has(contentType)) continue;

    try {
      const res = await fetch(att.url);
      if (!res.ok) continue;
      const buffer = await res.arrayBuffer();
      const data = Buffer.from(buffer).toString("base64");
      images.push({ data, mediaType: contentType });
      logger.debug(`[discord] Downloaded DM attachment ${att.filename} (${contentType})`);
    } catch (err) {
      logger.warn(`[discord] Failed to download DM attachment:`, err);
    }
  }

  return images;
}

/** Create a ReplySender for a sendable channel that supports image files. */
function makeReplySender(channel: { send: Function }): ReplySender {
  return async (responseText: string, imageFiles?: string[]) => {
    const chunks = splitMessage(responseText);
    for (const chunk of chunks) {
      await channel.send(chunk);
    }

    // Send image files as Discord attachments
    if (imageFiles?.length) {
      const files: AttachmentBuilder[] = [];
      for (const filePath of imageFiles) {
        try {
          const file = Bun.file(filePath);
          if (await file.exists()) {
            const buffer = Buffer.from(await file.arrayBuffer());
            files.push(new AttachmentBuilder(buffer, { name: basename(filePath) }));
          }
        } catch (err) {
          logger.warn(`[discord] Failed to read image file ${filePath}:`, err);
        }
      }
      if (files.length) {
        await channel.send({ files });
      }
    }
  };
}

export class DiscordChannel implements Channel {
  readonly name = "discord";
  private client: Client | null = null;
  private token: string;

  /** Expose the underlying client for the approval system. Available after start(). */
  getClient(): Client {
    if (!this.client) throw new Error("Discord client not started yet");
    return this.client;
  }

  /** Send a message to a channel by ID (used by scheduler). */
  async sendToChannel(channelId: string, text: string): Promise<void> {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !("send" in channel)) return;
      const chunks = splitMessage(text);
      for (const chunk of chunks) {
        await (channel as any).send(chunk);
      }
    } catch (err) {
      logger.error(`[discord] Failed to send to channel ${channelId}:`, err);
    }
  }

  /** Send a DM to a user by ID (used by scheduler). */
  async sendDm(userId: string, text: string): Promise<void> {
    if (!this.client) return;
    try {
      const user = await this.client.users.fetch(userId);
      const chunks = splitMessage(text);
      for (const chunk of chunks) {
        await user.send(chunk);
      }
    } catch (err) {
      logger.error(`[discord] Failed to DM user ${userId}:`, err);
    }
  }

  constructor(config: Config) {
    this.token = config.discordBotToken;
  }

  async start(
    onMessage: (msg: InboundMessage, reply: ReplySender) => Promise<void>
  ): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.User],
    });

    this.client.on(Events.ClientReady, () => {
      logger.info(`Discord bot logged in as ${this.client!.user?.tag}`);
    });

    // Handle guild messages
    this.client.on(Events.MessageCreate, async (message: Message) => {
      try {
        if (message.author.bot) return;
        if (!message.guild) return;

        const botId = this.client!.user!.id;

        // Case 1: Message inside a bot-created thread → continue session
        if (isThread(message.channel.type)) {
          const thread = message.channel as ThreadChannel;

          // Only handle threads owned by the bot
          if (thread.ownerId !== botId) return;

          const text = stripMention(message.content, botId);
          if (!text && message.attachments.size === 0) return;

          const attachments = await downloadImageAttachments(message);
          logger.debug(`[discord] Thread message from ${message.author.username} in ${thread.name}: ${text.slice(0, 100)} (${attachments.length} images)`);

          const mentions = message.mentions.users
            .filter((u) => !u.bot)
            .map((u) => ({ id: u.id, username: u.username }));

          const inbound: InboundMessage = {
            context: {
              platform: "discord",
              sessionKey: thread.id,
              userId: message.author.id,
              userName: message.author.username,
            },
            text: text || "(image attached)",
            attachments,
            mentions,
          };

          try { await thread.sendTyping(); } catch {}
          await onMessage(inbound, makeReplySender(thread));
          return;
        }

        // Case 2: Mention in a regular channel → create new thread
        const isMentioned = this.client!.user && message.mentions.has(this.client!.user);
        if (!isMentioned) return;

        const text = stripMention(message.content, botId);
        if (!text && message.attachments.size === 0) return;

        const attachments = await downloadImageAttachments(message);
        logger.debug(`[discord] New thread from ${message.author.username}: ${text.slice(0, 100)} (${attachments.length} images)`);

        // Create a thread from the user's message
        const displayText = text || "(image attached)";
        const threadName = displayText.slice(0, 90) + (displayText.length > 90 ? "..." : "");
        const thread = await (message.channel as TextChannel).threads.create({
          name: threadName,
          startMessage: message,
          autoArchiveDuration: 60,
        });

        const mentions = message.mentions.users
          .filter((u) => !u.bot)
          .map((u) => ({ id: u.id, username: u.username }));

        const inbound: InboundMessage = {
          context: {
            platform: "discord",
            sessionKey: thread.id,
            userId: message.author.id,
            userName: message.author.username,
          },
          text: displayText,
          attachments,
          mentions,
        };

        try { await thread.sendTyping(); } catch {}
        await onMessage(inbound, makeReplySender(thread));
      } catch (err) {
        logger.error(`[discord] Error handling guild message:`, err);
      }
    });

    // Handle DMs via raw event since discord.js drops DM messageCreate
    this.client.on(Events.Raw, async (event) => {
      try {
        if (event.t !== "MESSAGE_CREATE") return;
        if (event.d.guild_id) return;
        if (event.d.author.bot) return;

        const channelId = event.d.channel_id as string;
        const userId = event.d.author.id as string;
        const userName = event.d.author.username as string;
        const text = (event.d.content as string).trim();
        const rawAttachments = event.d.attachments as any[] | undefined;

        if (!text && (!rawAttachments || rawAttachments.length === 0)) return;

        const attachments = await downloadRawAttachments(rawAttachments ?? []);
        logger.debug(`[discord] DM from ${userName}: ${text.slice(0, 100)} (${attachments.length} images)`);

        const inbound: InboundMessage = {
          context: {
            platform: "discord",
            sessionKey: `dm:${channelId}`,
            userId,
            userName,
          },
          text: text || "(image attached)",
          attachments,
        };

        const channel = await this.client!.channels.fetch(channelId);
        if (!channel || !("send" in channel)) return;

        try {
          if ("sendTyping" in channel) {
            await (channel as any).sendTyping();
          }
        } catch {}

        await onMessage(inbound, makeReplySender(channel as any));
      } catch (err) {
        logger.error(`[discord] Error handling DM:`, err);
      }
    });

    await this.client.login(this.token);
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info("Discord bot disconnected");
    }
  }
}
