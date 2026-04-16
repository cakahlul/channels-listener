# channels-listener

A Bun application that bridges chat platforms to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI. Messages from any connected chat platform are forwarded to Claude Code as a subprocess, and responses are sent back through the originating platform.

Designed to run on a VPS with Cloudflare Tunnel (`cloudflared`) for secure exposure.

## Architecture

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│ Discord  │    │ Telegram │    │  Google  │
│   Bot    │    │   Bot    │    │   Chat   │    ...
└────┬─────┘    └────┬─────┘    └────┬─────┘
     │               │               │
     └───────────────┼───────────────┘
                     │
              ┌──────▼──────┐
              │ Orchestrator │  ← routes messages, manages sessions
              └──────┬──────┘
                     │
              ┌──────▼──────┐
              │ Claude Bridge│  ← spawns `claude --print --resume <id>`
              └──────┬──────┘
                     │
              ┌──────▼──────┐
              │  Claude Code │  ← CLI subprocess
              │     (CLI)    │
              └──────────────┘

              ┌──────────────┐
              │    Redis     │  ← session persistence with TTL
              └──────────────┘
```

### How it works

1. A **channel adapter** (e.g. Discord) receives a message from a user
2. The **orchestrator** looks up or creates a session for that user
3. The **Claude Bridge** spawns `claude --print --resume <sessionId>` as a subprocess
4. Claude's response flows back through the orchestrator to the channel adapter
5. The adapter sends the reply using the platform's API

### Project structure

```
src/
├── index.ts                  # Entry point — boots channels + orchestrator
├── config.ts                 # Environment variable loading & validation
├── types/
│   └── channel.ts            # Channel interface definition
├── core/
│   ├── orchestrator.ts       # Routes messages → Claude → replies
│   ├── claude-bridge.ts      # Spawns claude CLI subprocess per message
│   └── session-store.ts      # Maps user/channel → session ID in Redis with TTL
├── channels/
│   └── discord.ts            # Discord adapter (mentions + DMs)
└── utils/
    └── logger.ts             # Structured logging with levels
```

## Prerequisites

- [Bun](https://bun.sh) runtime installed
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- [Redis](https://redis.io) server running (used for session persistence)
- A Discord bot token (see [Discord Setup](#discord-setup))

## Installation

```bash
bun install
```

## Configuration

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | — | Discord bot token |
| `REDIS_URL` | No | `redis://localhost:6379` | Redis connection URL |
| `CLAUDE_WORK_DIR` | No | `process.cwd()` | Working directory for Claude Code subprocess |
| `CLAUDE_MODEL` | No | `sonnet` | Claude model to use |
| `CLAUDE_MAX_TURNS` | No | `25` | Max agentic turns per message |
| `SESSION_TTL_MINUTES` | No | `60` | Redis key expiry for sessions (minutes) |
| `MAX_CONCURRENT_CLAUDE` | No | `5` | Max concurrent Claude processes |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, or `error` |

## Running

```bash
# Production
bun run start

# Development (auto-reload on file changes)
bun run dev
```

## Discord Setup

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** and give it a name
3. Go to **Bot** tab:
   - Click **Reset Token** and copy it → set as `DISCORD_BOT_TOKEN`
   - Enable **Message Content Intent** under Privileged Gateway Intents
4. Go to **OAuth2** → **URL Generator**:
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Send Messages in Threads`, `Create Public Threads`, `Read Message History`
5. Copy the generated URL and open it to invite the bot to your server

### Usage in Discord

- **Mention the bot in a channel**: `@BotName what is the weather today?` → creates a new thread with its own Claude session
- **Reply in a thread**: Any user can continue the conversation inside the thread (shared session)
- **DM the bot**: Send a direct message (no mention needed, per-user session)
- **Reset conversation**: Type `/reset` in a thread or DM to start a fresh session

## VPS Deployment with Cloudflare Tunnel

> Note: Discord bots use a WebSocket gateway connection (outbound), so a tunnel is not strictly required for Discord alone. The tunnel becomes necessary when adding webhook-based platforms or serving a health-check endpoint.

```bash
# Install cloudflared on VPS
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install cloudflared

# Authenticate and create tunnel
cloudflared tunnel login
cloudflared tunnel create channels-listener

# Run the tunnel (configure in cloudflared config.yml to point to your app's port)
cloudflared tunnel run channels-listener
```

Ensure Redis is running on the VPS:

```bash
sudo apt install redis-server
sudo systemctl enable --now redis-server
```

For running channels-listener as a systemd service on the VPS:

```ini
# /etc/systemd/system/channels-listener.service
[Unit]
Description=Channels Listener - Chat to Claude Code Bridge
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/path/to/channels-listener
ExecStart=/usr/local/bin/bun run start
Restart=always
RestartSec=5
EnvironmentFile=/path/to/channels-listener/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now channels-listener
```

## Extending: Adding a New Channel

The application uses a channel adapter pattern. Each chat platform implements the `Channel` interface defined in `src/types/channel.ts`:

```typescript
export interface Channel {
  readonly name: string;
  start(onMessage: (msg: InboundMessage, reply: ReplySender) => void): Promise<void>;
  stop(): Promise<void>;
}
```

### Step-by-step guide

**1. Create the adapter file**

Create a new file in `src/channels/` — for example, `src/channels/telegram.ts`:

```typescript
import type { Channel, InboundMessage, ReplySender } from "../types/channel";
import type { Config } from "../config";
import { logger } from "../utils/logger";

export class TelegramChannel implements Channel {
  readonly name = "telegram";

  constructor(private config: Config) {}

  async start(
    onMessage: (msg: InboundMessage, reply: ReplySender) => void
  ): Promise<void> {
    // 1. Initialize your platform's SDK/client
    // 2. Listen for incoming messages
    // 3. For each message, construct an InboundMessage and a ReplySender:

    //   const inbound: InboundMessage = {
    //     context: {
    //       platform: "telegram",
    //       channelId: String(chatId),
    //       userId: String(fromId),
    //       userName: username,
    //     },
    //     text: messageText,
    //   };

    //   const reply: ReplySender = async (text: string) => {
    //     await telegramApi.sendMessage(chatId, text);
    //   };

    //   onMessage(inbound, reply);

    logger.info("Telegram channel started");
  }

  async stop(): Promise<void> {
    // Clean up connections
    logger.info("Telegram channel stopped");
  }
}
```

**2. Add configuration**

Add any new environment variables to `src/config.ts`:

```typescript
export interface Config {
  // ... existing fields
  telegramBotToken: string;
}
```

And to `.env.example`:

```
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
```

**3. Register the channel**

In `src/index.ts`, import and add the new channel:

```typescript
import { TelegramChannel } from "./channels/telegram";

const channels: Channel[] = [
  new DiscordChannel(config),
  new TelegramChannel(config),  // ← add here
];
```

That's it. The orchestrator, session management, and Claude Bridge work automatically for any registered channel.

### Key considerations when building an adapter

| Concern | How to handle |
|---------|---------------|
| **Message length limits** | Split long responses in the `ReplySender` (e.g. Discord = 2000 chars, Telegram = 4096 chars) |
| **Bot self-replies** | Filter out messages from your own bot to avoid loops |
| **Activation trigger** | Decide when the bot responds: mentions, DMs, slash commands, all messages, etc. |
| **Typing indicators** | Show a typing/processing indicator before calling `onMessage` for better UX |
| **Webhook vs. polling** | Some platforms (Telegram, Google Chat) support webhooks — use Cloudflare Tunnel to expose the endpoint. Others (Discord) use a persistent WebSocket |
| **Platform-specific formatting** | Convert Claude's Markdown output if the platform uses different formatting (e.g. Telegram uses HTML or its own Markdown variant) |

### Planned channels

- [x] Discord
- [ ] Telegram
- [ ] Google Chat
- [ ] WhatsApp (via WhatsApp Business API)
- [ ] iMessage (via AppleScript bridge on macOS or Beeper)

## Features

- **Session continuity** — each user gets a persistent Claude conversation via `--resume`, stored in Redis
- **Session persistence** — sessions survive app restarts since they're stored in Redis with automatic TTL expiry
- **Concurrency control** — configurable max concurrent Claude processes with queuing
- **In-flight dedup** — prevents double-processing when a user sends multiple messages quickly
- **Graceful shutdown** — clean disconnect from all platforms on SIGINT/SIGTERM
- **Extensible** — add a new platform by implementing one interface
- **Zero external dependencies for Redis** — uses Bun's built-in `RedisClient`

## License

MIT
