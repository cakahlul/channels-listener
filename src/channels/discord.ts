import {
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
import type { Config } from "../config";
import { logger } from "../utils/logger";

const MAX_MESSAGE_LENGTH = 2000;

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

export class DiscordChannel implements Channel {
  readonly name = "discord";
  private client: Client | null = null;
  private token: string;

  /** Expose the underlying client for the approval system. Available after start(). */
  getClient(): Client {
    if (!this.client) throw new Error("Discord client not started yet");
    return this.client;
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
          if (!text) return;

          logger.debug(`[discord] Thread message from ${message.author.username} in ${thread.name}: ${text.slice(0, 100)}`);

          const inbound: InboundMessage = {
            context: {
              platform: "discord",
              sessionKey: thread.id,
              userId: message.author.id,
              userName: message.author.username,
            },
            text,
          };

          const reply: ReplySender = async (responseText: string) => {
            const chunks = splitMessage(responseText);
            for (const chunk of chunks) {
              await thread.send(chunk);
            }
          };

          try { await thread.sendTyping(); } catch {}
          await onMessage(inbound, reply);
          return;
        }

        // Case 2: Mention in a regular channel → create new thread
        const isMentioned = this.client!.user && message.mentions.has(this.client!.user);
        if (!isMentioned) return;

        const text = stripMention(message.content, botId);
        if (!text) return;

        logger.debug(`[discord] New thread from ${message.author.username}: ${text.slice(0, 100)}`);

        // Create a thread from the user's message
        const threadName = text.slice(0, 90) + (text.length > 90 ? "..." : "");
        const thread = await (message.channel as TextChannel).threads.create({
          name: threadName,
          startMessage: message,
          autoArchiveDuration: 60,
        });

        const inbound: InboundMessage = {
          context: {
            platform: "discord",
            sessionKey: thread.id,
            userId: message.author.id,
            userName: message.author.username,
          },
          text,
        };

        const reply: ReplySender = async (responseText: string) => {
          const chunks = splitMessage(responseText);
          for (const chunk of chunks) {
            await thread.send(chunk);
          }
        };

        try { await thread.sendTyping(); } catch {}
        await onMessage(inbound, reply);
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

        if (!text) return;

        logger.debug(`[discord] DM from ${userName}: ${text.slice(0, 100)}`);

        const inbound: InboundMessage = {
          context: {
            platform: "discord",
            sessionKey: `dm:${channelId}`,
            userId,
            userName,
          },
          text,
        };

        const channel = await this.client!.channels.fetch(channelId);
        if (!channel || !("send" in channel)) return;

        const reply: ReplySender = async (responseText: string) => {
          const chunks = splitMessage(responseText);
          for (const chunk of chunks) {
            await (channel as any).send(chunk);
          }
        };

        try {
          if ("sendTyping" in channel) {
            await (channel as any).sendTyping();
          }
        } catch {}

        await onMessage(inbound, reply);
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
