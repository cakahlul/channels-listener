# File Index — channels-listener

Read this before any task. Update after any file add/remove/significant change.

## Features → Files

| Feature | Primary files |
|---|---|
| Entry / bootstrap | [src/index.ts](../src/index.ts) |
| Config / env loading | [src/config.ts](../src/config.ts), [.env.example](../.env.example) |
| Channel abstraction | [src/types/channel.ts](../src/types/channel.ts) |
| Discord adapter | [src/channels/discord.ts](../src/channels/discord.ts) |
| Message orchestration | [src/core/orchestrator.ts](../src/core/orchestrator.ts) |
| Claude SDK bridge | [src/core/claude-bridge.ts](../src/core/claude-bridge.ts) |
| Session storage (SQLite) | [src/core/session-store.ts](../src/core/session-store.ts) |
| Approval system | [src/approval/handler.ts](../src/approval/handler.ts), [src/approval/server.ts](../src/approval/server.ts), [src/approval/session-registry.ts](../src/approval/session-registry.ts), [scripts/approval-hook.ts](../scripts/approval-hook.ts) |
| Ad-hoc confirmation (DM Yes/No) | [src/approval/confirmation-handler.ts](../src/approval/confirmation-handler.ts), `POST /confirm` in [src/approval/server.ts](../src/approval/server.ts) |
| Scheduler (cron + NL parse) | [src/services/scheduler.ts](../src/services/scheduler.ts) |
| SQLite DB | [src/db/database.ts](../src/db/database.ts) |
| Logging | [src/utils/logger.ts](../src/utils/logger.ts) |
| Test/dev helpers | [scripts/test-dm.ts](../scripts/test-dm.ts) |

## File-by-file Logic

### [src/index.ts](../src/index.ts)
Boot sequence: loadConfig → set log level → configure scheduler → build `SessionRegistry` + `Orchestrator` → instantiate each channel → start channels with `orchestrator.handle` handler → start `ApprovalHandler` + `startApprovalServer` → wire scheduler senders + claudeBridge → `startScheduler()`. SIGINT/SIGTERM → graceful shutdown.

### [src/config.ts](../src/config.ts)
`Config` interface + `loadConfig()`. Validates `DISCORD_BOT_TOKEN`. Defaults: model=sonnet, maxTurns=25, sessionTtl=60min, maxConcurrent=5, approvalPort=7842, approvalTimeout=300s, dbPath=channels-listener.sqlite, schedulerTz=Asia/Jakarta, schedulerTick=60s, schedulerShellTimeout=600s, confirmTimeout=300s.

### [src/types/channel.ts](../src/types/channel.ts)
Interfaces: `ChannelContext` (platform/sessionKey/channelId/userId/userName), `InboundMessage` (context+text+attachments+mentions), `ReplySender`, `StreamingReplier` (onDelta/flush), `Channel` (name/start/stop).

### [src/channels/discord.ts](../src/channels/discord.ts)
`DiscordChannel` impl. Two paths:
- **Guild**: mention in regular channel → create thread → all subsequent thread messages route to same session. Thread ownership check (bot-owned only).
- **DM**: handled via raw `MESSAGE_CREATE` event (discord.js drops DM). sessionKey=`dm:{channelId}`.

Helpers: `splitMessage` (2000 char chunks, newline-aware), `stripMention`, `downloadImageAttachments` / `downloadRawAttachments` (PNG/JPEG/GIF/WebP → base64), `makeReplySender` (text chunks + image attachments), `makeStreamingReplier` (1s flush interval, edits in place, splits on 2000-char overflow). Public methods: `getClient`, `sendToChannel`, `sendDm` (scheduler hooks).

### [src/core/orchestrator.ts](../src/core/orchestrator.ts)
`Orchestrator.handle()`: handles `/reset` command, dispatches schedule commands via `handleScheduleCommand`, enforces single in-flight per `platform:sessionKey`, registers session→channel mapping for approvals, invokes `ClaudeBridge.ask` with optional streamer, replies. `toDiscordChannelId` strips `dm:` prefix.

### [src/core/claude-bridge.ts](../src/core/claude-bridge.ts)
`ClaudeBridge.ask()`: builds MessageParam (images + text), acquires `Semaphore` (maxConcurrent), calls SDK `query()` with `sessionId` (new) or `resume` (existing), streams `content_block_delta` text → `onTextDelta`, captures final `result` message. Extracts image paths from response text via `IMAGE_PATH_RE` and verifies existence via `Bun.file`. Returns `{ text, imageFiles }`.

### [src/core/session-store.ts](../src/core/session-store.ts)
SQLite-backed `SessionStore` (table `sessions`, PK `(platform, session_key)`, `expires_at` epoch-ms). `get()` returns existing+refresh TTL via UPDATE, or inserts new UUID. `reset()` deletes row. Periodic `purgeExpired` sweep every 5 min plus lazy filter on `get()` (rows past `expires_at` treated as missing). No external service required.

### [src/approval/handler.ts](../src/approval/handler.ts)
`ApprovalHandler.requestApproval()`: resolves channel via `SessionRegistry` (fallback to configured channel), renders rich embed via `formatToolInput` (per-tool formatters for Bash/Edit/Write/Read) + `toolMeta` (emoji+color map), posts Approve/Deny buttons, awaits button interaction OR timeout. Edits message to reflect outcome.

### [src/approval/server.ts](../src/approval/server.ts)
`startApprovalServer(approvalHandler, port, { confirmationHandler? })`: `Bun.serve` on port (default 7842). Routes: `POST /approval` (hook approval), `POST /confirm` (ad-hoc DM Yes/No — body `{ userId, prompt, title?, timeoutMs? }` → `{ approved, decidedBy }`), `GET /health` (pendingApprovals + pendingConfirmations).

### [src/approval/confirmation-handler.ts](../src/approval/confirmation-handler.ts)
`ConfirmationHandler.requestConfirmation({ userId, prompt, title?, timeoutMs? })`: DMs the target user with embed + Yes/No buttons, awaits interaction or timeout. CustomId pattern `confirm:<requestId>:yes|no`. Returns `{ approved: boolean, decidedBy: string }`. Auto-denies on timeout with `decidedBy="timeout"`. Used by external bots (e.g. clcok-automation) to ask for confirmation before running a scheduled action.

### [src/approval/session-registry.ts](../src/approval/session-registry.ts)
In-memory `Map<claudeSessionId, discordChannelId>` so approval prompts land in the originating thread/DM. Methods: register/resolve/remove.

### [scripts/approval-hook.ts](../scripts/approval-hook.ts)
Claude Code PreToolUse hook (bun shebang). Reads stdin JSON. Auto-allows: `AUTO_ALLOW_TOOLS` set (Bash, Agent, Read, Glob, Grep, WebFetch, WebSearch, ToolSearch, Task*, MCP read tools), any `mcp__*`, and Bash matching `READ_ONLY_BASH_PREFIXES` (git read, pm2 read, kubectl get, docker ps/logs, etc.) UNLESS hits `destructivePatterns` (rm, git push/reset/commit, pm2 start/stop, install/remove, redirects, etc.). Otherwise POSTs to approval server and emits hookSpecificOutput JSON. Logs to `/tmp/approval-hook.log`.

### [src/services/scheduler.ts](../src/services/scheduler.ts)
SQLite-backed cron. Components:
- **NL parser**: `parseScheduleWithClaude` — one-shot `query()` with strict JSON-only prompt → `{ cron, prompt, recurring, notify, directMessage }`.
- **Cron engine**: `parseCronField` (supports `*`, ranges, lists, steps `*/N`, `1-5/2`), `cronMatchesDate`, `dateInTimezone`, `describeCron` (human-readable), `nextRunTime` (48h forward search).
- **CRUD**: prepared statements over `schedules` table. `createSchedule`/`getSchedule`/`listSchedulesByChannel`/`removeSchedule`/`setScheduleEnabled`.
- **Execution**: `executeSchedule` — three modes by `executionMode`:
  - `shell`: `Bun.spawn(['bash','-lc', command])`, captures stdout/stderr, wraps result in code-fence, hard-killed via `AbortController` after `schedulerShellTimeoutMs` (default 600s). `SCHEDULE_ID` is exported to child env.
  - `direct`: deliver `prompt` as-is.
  - `task`: invoke `claudeBridge.ask` with fresh session UUID.
  Notify target → `sendDm` else `sendToChannel`. Auto-disables one-time after run.
- **Tick loop**: `startScheduler` runs `tick()` every `schedulerTickMs` (60s default), de-dupes if last run < 90s ago, in-flight `Set` prevents overlap.
- **Command handler**: `handleScheduleCommand` parses `schedule add|once|list|delete|pause|resume|shell <args>`, returns string or `"ASYNC"` for async add flow. `schedule shell "<cron>" [notify:self|notify:<userId>] [once] -- <command>` registers a shell-mode schedule synchronously.
- **Injection**: `setScheduleMessageSender`, `setScheduleDmSender`, `setSchedulerClaudeBridge` wired from `index.ts`.

### [src/db/database.ts](../src/db/database.ts)
`bun:sqlite` Database at `DB_PATH`. PRAGMA: WAL + foreign_keys. Creates `schedules` table on boot (id, channel_id, platform, cron_expression, prompt, timezone, created_by, created_by_id, recurring, direct_message, notify_user_id, notify_user_name, enabled, last_run_at, created_at, execution_mode, command). Idempotent `ALTER TABLE ADD COLUMN` runs for `execution_mode` + `command` so pre-existing DBs migrate on boot. Also creates `sessions` table (platform, session_key, session_id, expires_at; PK platform+session_key) with index on `expires_at` for purge sweeps.

### [src/utils/logger.ts](../src/utils/logger.ts)
Levels debug<info<warn<error. `setLogLevel`, `logger.{debug,info,warn,error}`. Timestamps ISO.

### [scripts/test-dm.ts](../scripts/test-dm.ts)
Dev helper to test DM sending. (Not loaded by main app.)

## Env Vars
DISCORD_BOT_TOKEN (required), CLAUDE_WORK_DIR, CLAUDE_MODEL, CLAUDE_MAX_TURNS, CLAUDE_CODE_PATH, SESSION_TTL_MINUTES, MAX_CONCURRENT_CLAUDE, LOG_LEVEL, APPROVAL_FALLBACK_CHANNEL_ID, APPROVAL_SERVER_PORT, APPROVAL_TIMEOUT_MS, DB_PATH, SCHEDULER_TIMEZONE, SCHEDULER_TICK_MS, SCHEDULER_SHELL_TIMEOUT_MS, CONFIRM_TIMEOUT_MS, APPROVAL_SERVER_URL (hook only), APPROVAL_HOOK_LOG (hook only).

## External Dependencies
- `@anthropic-ai/claude-agent-sdk` — `query()` streaming interface.
- `discord.js` v14 — guild + DM + thread + button interactions.
- Bun built-ins: `bun:sqlite`, `Bun.serve`, `Bun.file`.

## In-flight / known gaps
- No tests (`bun test` not yet wired).
- Telegram/Google Chat adapters not implemented.
- ApprovalHandler tightly coupled to Discord — needs abstraction for other platforms.
