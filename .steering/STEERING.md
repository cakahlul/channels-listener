# Steering Document — channels-listener

## Purpose
Bridge chat platforms (Discord + Google Chat today, Telegram planned) to a configured Claude or Codex agent. User messages go through one orchestrator and return through the originating platform. Designed for VPS deploy + Cloudflare Tunnel.

## Core Principles
- **Runtime**: Bun only. Never Node/npm/ts-node/vite/express/ws/dotenv/better-sqlite3/ioredis/pg. Use `Bun.serve`, `bun:sqlite`, built-in `WebSocket`, `Bun.file`, `Bun.$`.
- **Channels are pluggable**: implement `Channel` interface (`src/types/channel.ts`). New platforms drop into `src/channels/` and register in `src/index.ts`.
- **One orchestrator routes all platforms** → selected `AgentBridge` (`ClaudeBridge` or `CodexBridge`) → response. Sessions are provider-specific and stored in SQLite with `expires_at` TTL (lazy purge on read + periodic sweep).
- **Approvals out-of-band**: Claude hooks or Codex App Server requests → HTTP `/approval` (Bun.serve) → Discord button → decision returned to the provider.
- **Scheduler is SQLite-backed cron**: parses natural language through the selected agent bridge, ticks every minute, supports recurring/one-time, three execution modes (`direct` deliver-as-text, `task` agent-processed, `shell` external command via `Bun.spawn`).
- **External bots talk to us over HTTP**: the approval server exposes `POST /confirm` so sibling processes (e.g. clcok-automation) can request a Yes/No DM confirmation from the user without spinning up their own Discord client.
- **Streaming when supported**: streamer flushes text deltas to Discord edits at 1s interval. Non-stream channels get full response. Agent-created image files detected in final text are sent as channel attachments where supported.

## Architecture Layers
```
channels/*  →  Orchestrator  →  AgentBridge
                                  ├─ ClaudeBridge (Agent SDK)
                                  └─ CodexBridge (App Server JSON-RPC)
                ↓
              SessionStore (SQLite)
                ↓
              SessionRegistry (providerSessionId → discordChannelId)
                ↓
              ApprovalHandler ← Bun.serve(/approval) ← scripts/approval-hook.ts
                ↓
              Scheduler (bun:sqlite cron tick)
```

## Conventions
- Logger: `src/utils/logger.ts` — levels debug/info/warn/error. Use `logger.info(...)`, never `console.*`.
- Config: runtime settings live in `src/config.ts`; `DB_PATH` is also read during database module initialization, and standalone scripts read their own hook/test settings. `PROVIDER` selects `claude` or `codex`; invalid provider/Codex enum values fail startup.
- Session keys: Discord guild thread → `threadId`; Discord DM → `dm:{channelId}`; Google Chat → `{spaceName}::{threadName||"main"}`.
- Google Chat is HTTP-webhook (Bun.serve on `GOOGLE_CHAT_WEBHOOK_PORT`, default 7843); auth via service-account `chat.bot` scope. Replies must return `{}` synchronously and dispatch processing async.
- Schedules persisted in `channels-listener.sqlite` (WAL mode, table `schedules`).
- Approval hook auto-allows read-only tools (see `scripts/approval-hook.ts` AUTO_ALLOW_TOOLS / READ_ONLY_BASH_PREFIXES). Destructive ops → Discord buttons.
- Reply chunking: Discord 2000 char limit, prefer newline split at >50% boundary.

## Workflow Rules
1. **Before any task**: read `.steering/STEERING.md` AND `.steering/INDEX.md` first.
2. **After implementing/executing**: update `.steering/INDEX.md` (file entries, feature mapping) AND `STEERING.md` if architecture/conventions changed.
3. Prefer editing existing modules over adding new ones.
4. New channel adapter → implement `Channel`, register in `src/index.ts`, update INDEX.md.
5. New env var → add to `src/config.ts` Config interface + `loadConfig()` + `.env.example` + INDEX.md.

## Extension Points
- New chat platform: `src/channels/<name>.ts` implementing `Channel`.
- New schedule mode: extend `ExecutionMode` union + `Schedule` fields + `executeSchedule` branch in `src/services/scheduler.ts`; reflect in DB schema + idempotent migration in `src/db/database.ts`.
- New approval target (non-Discord): generalize `ApprovalHandler` / `ConfirmationHandler` (currently Discord-coupled).
- New HTTP-callable Discord action: add a route in `src/approval/server.ts` and a handler class beside `confirmation-handler.ts`.
