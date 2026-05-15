# Steering Document — channels-listener

## Purpose
Bridge chat platforms (Discord today, Telegram/Google Chat planned) → Claude Code CLI subprocess. User messages → Claude → reply sent back via originating platform. Designed for VPS deploy + Cloudflare Tunnel.

## Core Principles
- **Runtime**: Bun only. Never Node/npm/ts-node/vite/express/ws/dotenv/better-sqlite3/ioredis/pg. Use `Bun.serve`, `bun:sqlite`, `RedisClient` from `bun`, built-in `WebSocket`, `Bun.file`, `Bun.$`.
- **Channels are pluggable**: implement `Channel` interface (`src/types/channel.ts`). New platforms drop into `src/channels/` and register in `src/index.ts`.
- **One orchestrator routes all platforms** → ClaudeBridge → response. Sessions keyed by `platform:sessionKey` in Redis w/ TTL.
- **Approvals out-of-band**: Claude Code hook → HTTP `/approval` (Bun.serve) → Discord button → resolved Promise → hook stdout.
- **Scheduler is SQLite-backed cron**: parses NL via one-shot Claude query, ticks every minute, supports recurring/one-time, three execution modes (`direct` deliver-as-text, `task` Claude-processed, `shell` external command via `Bun.spawn`).
- **External bots talk to us over HTTP**: the approval server exposes `POST /confirm` so sibling processes (e.g. clcok-automation) can request a Yes/No DM confirmation from the user without spinning up their own Discord client.
- **Streaming when supported**: streamer flushes text deltas to Discord edits at 1s interval. Non-stream channels get full response.

## Architecture Layers
```
channels/*  →  Orchestrator  →  ClaudeBridge (SDK query)  →  Claude Code CLI
                ↓
              SessionStore (Redis)
                ↓
              SessionRegistry (claudeSessionId → discordChannelId)
                ↓
              ApprovalHandler ← Bun.serve(/approval) ← scripts/approval-hook.ts
                ↓
              Scheduler (bun:sqlite cron tick)
```

## Conventions
- Logger: `src/utils/logger.ts` — levels debug/info/warn/error. Use `logger.info(...)`, never `console.*`.
- Config: all env reads in `src/config.ts`. Never read `process.env` elsewhere.
- Session keys: Discord guild thread → `threadId`; Discord DM → `dm:{channelId}`.
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
