# channels-listener

A Bun application that connects Discord and Google Chat to either Claude Code or Codex. Set `PROVIDER=claude` for the Claude Agent SDK or `PROVIDER=codex` for the local [Codex App Server](https://developers.openai.com/codex/app-server/).

Both providers support persistent conversations, streaming text, image input, concurrency limits, and the scheduler. Codex command and file-change approvals are forwarded to Discord; unsupported App Server requests fail immediately instead of leaving turns blocked.

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
              │ Agent Bridge │
              └──────┬──────┘
                     │
          ┌──────────┴──────────┐
          │                     │
   ┌──────▼──────┐       ┌──────▼──────┐
   │ Claude SDK  │       │ Codex App   │
   │             │       │ Server      │
   └─────────────┘       └─────────────┘

              ┌──────────────┐
              │   SQLite     │  ← session persistence (TTL) + schedules
              └──────────────┘
```

### How it works

1. A **channel adapter** (e.g. Discord) receives a message from a user
2. The **orchestrator** looks up or creates a session for that user
3. The orchestrator calls the configured **agent bridge**
4. The selected provider's response flows back to the channel adapter
5. The adapter sends the reply using the platform's API

### Project structure

```
src/
├── index.ts                  # Entry point — boots channels + orchestrator
├── config.ts                 # Environment variable loading & validation
├── types/
│   └── channel.ts            # Channel interface definition
├── core/
│   ├── orchestrator.ts       # Routes messages → selected agent → replies
│   ├── claude-bridge.ts      # Claude Agent SDK bridge
│   ├── codex-bridge.ts       # Persistent Codex App Server JSON-RPC bridge
│   └── session-store.ts      # Maps user/channel → session ID in SQLite with TTL
├── channels/
│   ├── discord.ts            # Discord adapter (mentions + DMs)
│   └── google-chat.ts        # Google Chat webhook adapter
└── utils/
    └── logger.ts             # Structured logging with levels
```

## Quick Start for Non-Developers (Mac & Windows)

No coding background? Follow these steps end-to-end and you'll have the bot running on your own computer. You'll be copy-pasting commands into a terminal — that's it.

### What you'll need (overview)

1. A **terminal** app (already on your computer)
2. **Bun** — the engine that runs the app
3. **Claude Code or Codex CLI** — install and sign in to the provider you want to use
4. A **Discord bot token** — free, takes ~5 minutes to create

Sessions and schedules are stored in a local **SQLite** file (`channels-listener.sqlite`) that's created automatically on first run — no separate database to install.

---

### Step 1 — Open a terminal

- **Mac**: Press `Cmd + Space`, type `Terminal`, press Enter.
- **Windows**: Press the Windows key, type `PowerShell`, press Enter. (For best results, install **WSL** — Windows Subsystem for Linux — by running `wsl --install` in PowerShell as Administrator, then restart and use the Ubuntu terminal.)

### Step 2 — Install Bun

**Mac / Linux / WSL:**
```bash
curl -fsSL https://bun.sh/install | bash
```

**Windows (PowerShell, no WSL):**
```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Close and reopen your terminal, then verify:
```bash
bun --version
```
You should see a version number (e.g. `1.1.x`).

### Step 3 — Install an agent CLI

Choose one provider.

**Claude Code (default):**

```bash
npm install -g @anthropic-ai/claude-code
```
(Don't have `npm`? Install [Node.js LTS](https://nodejs.org/) first — `npm` comes with it.)

Then log in to your Claude account:
```bash
claude
```
Follow the prompts in your browser to authenticate, then type `/exit` to close it.

**Codex:**

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex
```

Sign in when prompted, then exit Codex. Set `PROVIDER=codex` in `.env` during Step 7.

### Step 4 — Create a Discord bot

Follow the [Discord Setup](#discord-setup) section below. You only need the **bot token** for now — save it somewhere safe.

### Step 5 — Download this app

```bash
git clone https://github.com/cakahlul/channels-listener.git
cd channels-listener
```
(No `git`? On Mac: `brew install git`. On Windows: install [Git for Windows](https://git-scm.com/download/win).)

### Step 6 — Install the app's dependencies

```bash
bun install
```

### Step 7 — Configure your settings

Copy the example file and open it in a text editor:

**Mac / Linux / WSL:**
```bash
cp .env.example .env
open .env       # Mac
# or: nano .env  (works everywhere)
```

**Windows (PowerShell):**
```powershell
Copy-Item .env.example .env
notepad .env
```

Paste your Discord bot token in the `DISCORD_BOT_TOKEN=` line. Keep `PROVIDER=claude`, or change it to `PROVIDER=codex` if you installed Codex. Save and close.

### Step 8 — Run the bot

```bash
bun run start
```

You should see log messages like `Discord channel started`. Open Discord, mention your bot in a channel (e.g. `@YourBot hello!`), and it will reply. Press `Ctrl + C` in the terminal to stop the bot.

### Troubleshooting

| Problem | Fix |
|---|---|
| `command not found: bun` | Close and reopen the terminal. If still missing, re-run the Bun install step. |
| `claude: command not found` | Re-run `npm install -g @anthropic-ai/claude-code`. On Mac, you may need `sudo`. |
| `codex: command not found` | Re-run the Codex installer, reopen the terminal, or set `CODEX_PATH` to the executable's absolute path. |
| Bot is online but doesn't reply | Make sure **Message Content Intent** is enabled in the Discord Developer Portal (Bot tab → Privileged Gateway Intents). |
| `DISCORD_BOT_TOKEN is required` | Open `.env` again and confirm the token is pasted without quotes or extra spaces. |

---

## Prerequisites

- [Bun](https://bun.sh) runtime installed
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) or [Codex CLI](https://developers.openai.com/codex/cli/) installed and authenticated
- A Discord bot token (see [Discord Setup](#discord-setup))

Sessions and schedules are persisted to a local SQLite file (`channels-listener.sqlite`) created on first run.

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
| `PROVIDER` | No | `claude` | Agent provider: `claude` or `codex`; invalid values fail startup |
| `CLAUDE_WORK_DIR` | No | current directory | Claude working directory |
| `CLAUDE_MODEL` | No | `sonnet` | Claude model to use |
| `CLAUDE_MAX_TURNS` | No | `25` | Max agentic turns per message |
| `CLAUDE_CODE_PATH` | No | `claude` on `PATH` | Claude executable path |
| `CODEX_PATH` | No | `codex` on `PATH` | Codex executable path |
| `CODEX_MODEL` | No | Codex configuration | Optional model override |
| `CODEX_REASONING_EFFORT` | No | Codex configuration | Optional effort override: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` (model-dependent) |
| `CODEX_WORK_DIR` | No | `CLAUDE_WORK_DIR`, then current directory | Codex working directory |
| `CODEX_APPROVAL_POLICY` | No | Codex configuration | `untrusted`, `on-request`, or `never` |
| `CODEX_SANDBOX` | No | Codex configuration | `read-only`, `workspace-write`, or `danger-full-access` |
| `CODEX_TIMEOUT_MS` | No | `600000` | Codex turn timeout; timed-out turns are interrupted |
| `DB_PATH` | No | `channels-listener.sqlite` | SQLite file for sessions + schedules |
| `SESSION_TTL_MINUTES` | No | `60` | Session expiry in SQLite (minutes) |
| `MAX_CONCURRENT_CLAUDE` | No | `5` | Max concurrent agent requests for either provider |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, or `error` |

Codex model, reasoning, approval, and sandbox overrides are optional. When omitted, App Server uses normal Codex user/project configuration. `CLAUDE_MAX_TURNS` applies only to Claude; Codex uses `CODEX_TIMEOUT_MS` as this app's turn bound.

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

- **Mention the bot in a channel**: `@BotName what is the weather today?` → creates a new thread with its own agent session
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

For running channels-listener as a systemd service on the VPS:

```ini
# /etc/systemd/system/channels-listener.service
[Unit]
Description=Channels Listener - Chat to Agent Bridge
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

That's it. The orchestrator, session management, and selected agent bridge work automatically for any registered channel.

### Key considerations when building an adapter

| Concern | How to handle |
|---------|---------------|
| **Message length limits** | Split long responses in the `ReplySender` (e.g. Discord = 2000 chars, Telegram = 4096 chars) |
| **Bot self-replies** | Filter out messages from your own bot to avoid loops |
| **Activation trigger** | Decide when the bot responds: mentions, DMs, slash commands, all messages, etc. |
| **Typing indicators** | Show a typing/processing indicator before calling `onMessage` for better UX |
| **Webhook vs. polling** | Some platforms (Telegram, Google Chat) support webhooks — use Cloudflare Tunnel to expose the endpoint. Others (Discord) use a persistent WebSocket |
| **Platform-specific formatting** | Convert agent Markdown output if the platform uses different formatting (e.g. Telegram uses HTML or its own Markdown variant) |

### Planned channels

- [x] Discord
- [ ] Telegram
- [x] Google Chat
- [ ] WhatsApp (via WhatsApp Business API)
- [ ] iMessage (via AppleScript bridge on macOS or Beeper)

## Features

- **Session continuity** — each user gets a provider-specific conversation; Claude session IDs and Codex thread IDs are stored in SQLite
- **Session persistence** — sessions resume after app or Codex App Server restarts; expired rows are purged lazily and periodically
- **Concurrency control** — configurable max concurrent agent requests with queuing
- **In-flight dedup** — prevents double-processing when a user sends multiple messages quickly
- **Graceful shutdown** — clean disconnect from all platforms on SIGINT/SIGTERM
- **Extensible** — add a new platform by implementing one interface
- **Zero external services** — uses Bun's built-in `bun:sqlite`; no Redis or other DB needed

## License

MIT
