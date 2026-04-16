/**
 * Minimal DM test — run with: bun scripts/test-dm.ts
 * If this doesn't log DMs, the issue is Discord bot configuration.
 */
import { Client, GatewayIntentBits, Partials, Events } from "discord.js";

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error("DISCORD_BOT_TOKEN not set");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User],
});

client.on(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  console.log(`Bot ID: ${c.user.id}`);
  console.log("Waiting for messages (guild + DM)...");
});

// Log ALL raw gateway events
client.on(Events.Raw, (event) => {
  if (event.t === "MESSAGE_CREATE") {
    console.log(`[RAW] MESSAGE_CREATE guild_id=${event.d.guild_id ?? "DM"} author=${event.d.author.username} content="${event.d.content}"`);
  }
});

client.on(Events.MessageCreate, async (message) => {
  console.log(`[EVENT] messageCreate guild=${message.guild?.id ?? "DM"} author=${message.author?.username} content="${message.content}"`);
});

client.login(token);
