---
name: Discord approval routing to active session
description: In-progress feature to route Claude Code approval prompts to the active Discord thread/DM instead of a fixed channel
type: project
---

User wants Claude Code permission approvals forwarded to the **same Discord thread/DM** where the conversation is happening, not a fixed channel.

**Why:** So the approval context stays inline with the conversation — no need to switch channels or open Claude Code.

**Current state (partially done):**
- Core approval system is built and compiles: handler, HTTP server, hook script, hook config
- Files created: `src/approval/handler.ts`, `src/approval/server.ts`, `scripts/approval-hook.ts`
- Hook configured in `~/.claude/settings.json` using `PermissionRequest` event
- BUT: currently sends to a fixed `APPROVAL_CHANNEL_ID` channel

**Remaining work to route approvals to the active session:**
1. Create `src/approval/session-registry.ts` — simple in-memory Map of `claude_session_id → discord_channel_id`
2. Update `src/core/orchestrator.ts` — after `sessions.get()`, register `session.sessionId → context.sessionKey` (thread ID is the Discord channel ID; for DMs extract from `dm:{channelId}`)
3. Update `src/approval/handler.ts` — accept registry, look up channel from `req.sessionId` instead of fixed `this.channelId`, keep fallback channel as optional
4. Update `src/config.ts` — make `approvalChannelId` optional (fallback only)
5. Update `src/index.ts` — create registry, pass to both orchestrator and approval handler
6. Update `.env` / `.env.example` — mark `APPROVAL_CHANNEL_ID` as optional fallback
7. Type-check with `bunx tsc --noEmit`

**How to apply:** Continue from step 1 above. The orchestrator already knows the Discord sessionKey (thread ID or `dm:channelId`) and the Claude session UUID — just need to bridge them.
