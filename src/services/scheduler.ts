import { query } from "@anthropic-ai/claude-agent-sdk";
import { db } from "../db/database";
import { logger } from "../utils/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Schedule {
  id: string;
  channelId: string;
  platform: string;
  cronExpression: string;
  prompt: string;
  timezone: string;
  createdBy: string;
  createdById: string;
  recurring: boolean;
  directMessage: boolean;
  notifyUserId: string | null;
  notifyUserName: string | null;
  enabled: boolean;
  lastRunAt: number | null;
  createdAt: number;
}

interface ScheduleRow {
  id: string;
  channel_id: string;
  platform: string;
  cron_expression: string;
  prompt: string;
  timezone: string;
  created_by: string;
  created_by_id: string;
  recurring: number;
  direct_message: number;
  notify_user_id: string | null;
  notify_user_name: string | null;
  enabled: number;
  last_run_at: number | null;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

const insertSchedule = db.query<void, [string, string, string, string, string, string, string, string, number, number, number, string | null, string | null]>(`
  INSERT INTO schedules (id, channel_id, platform, cron_expression, prompt, timezone, created_by, created_by_id, created_at, recurring, direct_message, notify_user_id, notify_user_name)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectScheduleById = db.query<ScheduleRow, [string]>(
  "SELECT * FROM schedules WHERE id = ?",
);

const selectSchedulesByChannel = db.query<ScheduleRow, [string]>(
  "SELECT * FROM schedules WHERE channel_id = ? ORDER BY created_at DESC",
);

const selectAllEnabled = db.query<ScheduleRow, []>(
  "SELECT * FROM schedules WHERE enabled = 1",
);

const updateEnabled = db.query<void, [number, string]>(
  "UPDATE schedules SET enabled = ? WHERE id = ?",
);

const updateLastRun = db.query<void, [number, string]>(
  "UPDATE schedules SET last_run_at = ? WHERE id = ?",
);

const deleteScheduleById = db.query<void, [string]>(
  "DELETE FROM schedules WHERE id = ?",
);

const deleteSchedulesByChannel = db.query<void, [string]>(
  "DELETE FROM schedules WHERE channel_id = ?",
);

// ---------------------------------------------------------------------------
// Natural language → cron (via Claude)
// ---------------------------------------------------------------------------

export interface ParsedScheduleInput {
  cronExpression: string;
  prompt: string;
  recurring: boolean;
  /** "self" = DM the creator, a display name = DM that person, null = post in channel */
  notifyTarget: string | null;
  /** true = just deliver the prompt text as-is (no Claude processing) */
  directMessage: boolean;
}

let schedulerTimezone = "Asia/Jakarta";
let schedulerTickMs = 60_000;
let schedulerClaudeCodePath: string | undefined;

export function configureScheduler(opts: { timezone?: string; tickMs?: number; claudeCodePath?: string }) {
  if (opts.timezone) schedulerTimezone = opts.timezone;
  if (opts.tickMs) schedulerTickMs = opts.tickMs;
  if (opts.claudeCodePath) schedulerClaudeCodePath = opts.claudeCodePath;
}

/**
 * Spawn a one-shot Claude Code session to parse natural-language schedule
 * input into { cron, prompt, recurring }.
 */
export async function parseScheduleWithClaude(rawInput: string): Promise<ParsedScheduleInput> {
  const now = new Date();
  const localNow = now.toLocaleString("en-US", {
    timeZone: schedulerTimezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const prompt = `You are a schedule parser. Parse the following user input and extract:
1. A standard 5-field cron expression (minute hour day-of-month month day-of-week)
2. The task prompt or message content
3. Whether this is recurring or one-time
4. Who to notify/chat with the result (if mentioned)
5. Whether this is a direct message delivery (just send the text as-is) or a task for Claude to process

Current time: ${localNow} (${schedulerTimezone})

Rules:
- Day-of-week: 0=Sun, 1=Mon, ..., 6=Sat
- If the user says "once" or "sekali" or implies a single run, set recurring=false
- If ambiguous, default to recurring=true
- For notify: if user says "chat gw", "chat me", "kirim ke gw", "DM me" → set notify to "self"
- If user says "chat @Someone" or "kirim ke @Someone" → set notify to that person's name
- If no notification target mentioned → set notify to null (result stays in the channel)
- directMessage=true when the user wants to SEND/DELIVER a specific message to someone (e.g. "kirim pesan ke X isinya Y", "send message to X saying Y"). The prompt should be the message content only.
- directMessage=false when the user wants Claude to DO something (e.g. "summarize inbox", "check system health"). The prompt should describe the task.
- The notify target name should NOT be included in the prompt
- Respond ONLY with valid JSON, no markdown fences, no explanation

JSON format: {"cron":"<5 fields>","prompt":"<message or task>","recurring":<true|false>,"notify":<"self"|"Person Name"|null>,"directMessage":<true|false>}

User input: ${rawInput}`;

  let resultText = "";

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 60_000);

  try {
    for await (const message of query({
      prompt,
      options: {
        maxTurns: 1,
        abortController,
        ...(schedulerClaudeCodePath ? { pathToClaudeCodeExecutable: schedulerClaudeCodePath } : {}),
      } as any,
    })) {
      if ("result" in message) {
        resultText = (message as any).result;
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  if (!resultText) {
    throw new Error("Empty response from schedule parser");
  }

  logger.debug("Schedule parser raw response", { text: resultText });

  // Strip markdown fences if the model wraps them
  const jsonStr = resultText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  // Try to find JSON in the response
  const jsonMatch = jsonStr.match(/\{[^}]*"cron"[^}]*\}/);
  const toParse = jsonMatch ? jsonMatch[0] : jsonStr;

  let parsed: { cron?: string; prompt?: string; recurring?: boolean };
  try {
    parsed = JSON.parse(toParse);
  } catch {
    throw new Error(`Failed to parse schedule response: ${resultText.slice(0, 200)}`);
  }

  if (!parsed.cron || !parsed.prompt) {
    throw new Error(`Incomplete schedule parse: ${JSON.stringify(parsed)}`);
  }

  const cronParts = parsed.cron.trim().split(/\s+/);
  if (cronParts.length !== 5) {
    throw new Error(`Invalid cron from parser: "${parsed.cron}" (expected 5 fields)`);
  }

  return {
    cronExpression: parsed.cron.trim(),
    prompt: parsed.prompt,
    recurring: parsed.recurring ?? true,
    notifyTarget: (parsed as any).notify ?? null,
    directMessage: (parsed as any).directMessage ?? false,
  };
}

// ---------------------------------------------------------------------------
// Cron parser
// ---------------------------------------------------------------------------

function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const trimmed = part.trim();

    const stepMatch = trimmed.match(/^(?:(\d+)-(\d+)|(\*))\/(\d+)$/);
    if (stepMatch) {
      const rangeStart = stepMatch[1] !== undefined ? Number(stepMatch[1]) : min;
      const rangeEnd = stepMatch[2] !== undefined ? Number(stepMatch[2]) : max;
      const step = Number(stepMatch[4]);
      for (let i = rangeStart; i <= rangeEnd; i += step) {
        values.add(i);
      }
      continue;
    }

    if (trimmed === "*") {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }

    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      for (let i = start; i <= end; i++) values.add(i);
      continue;
    }

    const num = Number(trimmed);
    if (!isNaN(num)) {
      values.add(num);
    }
  }

  return values;
}

export function cronMatchesDate(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    logger.warn("Invalid cron expression (expected 5 fields)", { cron });
    return false;
  }

  const [minuteF, hourF, domF, monthF, dowF] = parts;
  const minutes = parseCronField(minuteF!, 0, 59);
  const hours = parseCronField(hourF!, 0, 23);
  const doms = parseCronField(domF!, 1, 31);
  const months = parseCronField(monthF!, 1, 12);
  const dows = parseCronField(dowF!, 0, 6);
  if (dowF!.includes("7")) dows.add(0);

  const m = date.getMinutes();
  const h = date.getHours();
  const dom = date.getDate();
  const mon = date.getMonth() + 1;
  const dow = date.getDay();

  return minutes.has(m) && hours.has(h) && doms.has(dom) && months.has(mon) && dows.has(dow);
}

function dateInTimezone(date: Date, timezone: string): Date {
  const str = date.toLocaleString("en-US", { timeZone: timezone });
  return new Date(str);
}

export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;

  const [minute, hour, dom, month, dow] = parts;

  const dowNames: Record<string, string> = {
    "0": "Sun", "1": "Mon", "2": "Tue", "3": "Wed",
    "4": "Thu", "5": "Fri", "6": "Sat", "7": "Sun",
  };

  let desc = "";

  if (dow === "*" && dom === "*") {
    desc = "Every day";
  } else if (dow === "1-5") {
    desc = "Weekdays (Mon-Fri)";
  } else if (dow === "0,6") {
    desc = "Weekends";
  } else if (dow !== "*") {
    const days = dow!.split(",").map((d) => {
      if (d.includes("-")) {
        const [s, e] = d.split("-");
        return `${dowNames[s!] || s}-${dowNames[e!] || e}`;
      }
      return dowNames[d] || d;
    });
    desc = days.join(", ");
  } else {
    desc = `Day ${dom} of month`;
  }

  const pad = (n: string) => n.padStart(2, "0");
  if (hour !== "*" && minute !== "*") {
    desc += ` at ${pad(hour!)}:${pad(minute!)}`;
  } else if (hour !== "*") {
    desc += ` at ${pad(hour!)}:xx`;
  } else if (minute !== "*") {
    const step = minute!.match(/^\*\/(\d+)$/);
    if (step) {
      desc += ` every ${step[1]} minutes`;
    } else {
      desc += ` at minute ${minute}`;
    }
  }

  if (month !== "*") {
    const monthNames = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    desc += ` in ${month!.split(",").map((m) => monthNames[Number(m)] || m).join(", ")}`;
  }

  return desc;
}

export function nextRunTime(cron: string, timezone: string, from?: Date): Date | null {
  const start = from || new Date();
  const cursor = new Date(start);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const limit = 48 * 60;
  for (let i = 0; i < limit; i++) {
    const local = dateInTimezone(cursor, timezone);
    if (cronMatchesDate(cron, local)) {
      return cursor;
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Row → Schedule helper
// ---------------------------------------------------------------------------

function rowToSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    channelId: row.channel_id,
    platform: row.platform,
    cronExpression: row.cron_expression,
    prompt: row.prompt,
    timezone: row.timezone,
    createdBy: row.created_by,
    createdById: row.created_by_id,
    recurring: row.recurring === 1,
    directMessage: row.direct_message === 1,
    notifyUserId: row.notify_user_id,
    notifyUserName: row.notify_user_name,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function createSchedule(
  channelId: string,
  platform: string,
  cronExpression: string,
  prompt: string,
  createdBy: string,
  createdById: string,
  options?: {
    timezone?: string;
    recurring?: boolean;
    directMessage?: boolean;
    notifyUserId?: string | null;
    notifyUserName?: string | null;
  },
): Schedule {
  const id = crypto.randomUUID().slice(0, 8);
  const tz = options?.timezone || schedulerTimezone;
  const recurring = options?.recurring ?? true;
  const directMessage = options?.directMessage ?? false;
  const notifyUserId = options?.notifyUserId ?? null;
  const notifyUserName = options?.notifyUserName ?? null;
  const now = Date.now();

  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
  }

  insertSchedule.run(id, channelId, platform, cronExpression, prompt, tz, createdBy, createdById, now, recurring ? 1 : 0, directMessage ? 1 : 0, notifyUserId, notifyUserName);
  logger.info("Schedule created", { id, channelId, cronExpression, recurring, directMessage, prompt: prompt.slice(0, 100), createdBy });

  return {
    id,
    channelId,
    platform,
    cronExpression,
    prompt,
    timezone: tz,
    createdBy,
    createdById,
    recurring,
    directMessage,
    notifyUserId,
    notifyUserName,
    enabled: true,
    lastRunAt: null,
    createdAt: now,
  };
}

export function getSchedule(id: string): Schedule | null {
  const row = selectScheduleById.get(id);
  return row ? rowToSchedule(row) : null;
}

export function listSchedulesByChannel(channelId: string): Schedule[] {
  return selectSchedulesByChannel.all(channelId).map(rowToSchedule);
}

export function removeSchedule(id: string): boolean {
  const existing = selectScheduleById.get(id);
  if (!existing) return false;
  deleteScheduleById.run(id);
  logger.info("Schedule deleted", { id });
  return true;
}

export function removeSchedulesByChannel(channelId: string): void {
  deleteSchedulesByChannel.run(channelId);
}

export function setScheduleEnabled(id: string, enabled: boolean): boolean {
  const existing = selectScheduleById.get(id);
  if (!existing) return false;
  updateEnabled.run(enabled ? 1 : 0, id);
  logger.info("Schedule toggled", { id, enabled });
  return true;
}

// ---------------------------------------------------------------------------
// Message sender callback — set by index.ts after Discord client is ready
// ---------------------------------------------------------------------------

export type ScheduleMessageSender = (channelId: string, text: string) => Promise<void>;
export type ScheduleDmSender = (userId: string, text: string) => Promise<void>;

let sendToChannel: ScheduleMessageSender | null = null;
let sendDm: ScheduleDmSender | null = null;

export function setScheduleMessageSender(sender: ScheduleMessageSender) {
  sendToChannel = sender;
}

export function setScheduleDmSender(sender: ScheduleDmSender) {
  sendDm = sender;
}

// ---------------------------------------------------------------------------
// Claude bridge reference — set by index.ts
// ---------------------------------------------------------------------------

import type { ClaudeBridge } from "../core/claude-bridge";

let claudeBridge: ClaudeBridge | null = null;

export function setSchedulerClaudeBridge(bridge: ClaudeBridge) {
  claudeBridge = bridge;
}

// ---------------------------------------------------------------------------
// Job execution
// ---------------------------------------------------------------------------

const runningSchedules = new Set<string>();

async function executeSchedule(schedule: Schedule): Promise<void> {
  if (runningSchedules.has(schedule.id)) {
    logger.debug("Schedule already running, skipping", { id: schedule.id });
    return;
  }

  runningSchedules.add(schedule.id);
  const startTime = Date.now();

  logger.info("Executing scheduled job", {
    id: schedule.id,
    channelId: schedule.channelId,
    cron: schedule.cronExpression,
    prompt: schedule.prompt.slice(0, 100),
  });

  try {
    const hasNotifyTarget = !!(schedule.notifyUserId || schedule.notifyUserName);

    // --- Direct message mode: just deliver the text, no Claude ---
    if (schedule.directMessage) {
      if (hasNotifyTarget && schedule.notifyUserId && sendDm) {
        await sendDm(schedule.notifyUserId, schedule.prompt);
        if (sendToChannel) {
          await sendToChannel(schedule.channelId, `✅ Message delivered to ${schedule.notifyUserName || "DM"}`);
        }
      } else if (sendToChannel) {
        await sendToChannel(schedule.channelId, schedule.prompt);
      }

      updateLastRun.run(Date.now(), schedule.id);

      if (!schedule.recurring) {
        updateEnabled.run(0, schedule.id);
        logger.info("One-time schedule auto-disabled after run", { id: schedule.id });
        if (sendToChannel) {
          await sendToChannel(schedule.channelId, `✅ One-time schedule \`${schedule.id}\` completed and auto-disabled.`);
        }
      }

      logger.info("Direct message schedule completed", { id: schedule.id });
      return;
    }

    // --- Task mode: invoke Claude and deliver the result ---
    if (!claudeBridge) {
      logger.error("Claude bridge not configured for scheduler");
      return;
    }

    if (sendToChannel) {
      const msg = hasNotifyTarget
        ? `⏰ *Scheduled task running* → result will be sent to ${schedule.notifyUserName || "DM"}\n📝 ${schedule.prompt.slice(0, 200)}`
        : `⏰ *Scheduled task running*\n📝 ${schedule.prompt.slice(0, 200)}`;
      await sendToChannel(schedule.channelId, msg);
    }

    // Create a unique session for this schedule
    const sessionId = crypto.randomUUID();
    const result = await claudeBridge.ask(schedule.prompt, sessionId, true);

    // Send result to DM or channel
    if (hasNotifyTarget && schedule.notifyUserId && sendDm) {
      await sendDm(schedule.notifyUserId, result.text);
      if (sendToChannel) {
        await sendToChannel(schedule.channelId, `✅ Schedule \`${schedule.id}\` completed — result sent to ${schedule.notifyUserName || "DM"}`);
      }
    } else if (sendToChannel) {
      await sendToChannel(schedule.channelId, result.text);
    }

    updateLastRun.run(Date.now(), schedule.id);

    if (!schedule.recurring) {
      updateEnabled.run(0, schedule.id);
      logger.info("One-time schedule auto-disabled after run", { id: schedule.id });
      if (sendToChannel) {
        await sendToChannel(schedule.channelId, `✅ One-time schedule \`${schedule.id}\` completed and auto-disabled.`);
      }
    }

    logger.info("Scheduled job completed", {
      id: schedule.id,
      recurring: schedule.recurring,
      durationMs: Date.now() - startTime,
      responseLength: result.text.length,
    });
  } catch (err) {
    logger.error("Scheduled job failed", {
      id: schedule.id,
      error: String(err),
      stack: (err as Error).stack,
    });

    if (sendToChannel) {
      sendToChannel(schedule.channelId, `❌ Scheduled task failed: ${String(err).slice(0, 300)}`).catch(() => {});
    }
  } finally {
    runningSchedules.delete(schedule.id);
  }
}

// ---------------------------------------------------------------------------
// Tick — runs every minute, checks all enabled schedules
// ---------------------------------------------------------------------------

function tick(): void {
  const now = new Date();
  const schedules = selectAllEnabled.all();

  if (schedules.length === 0) return;

  logger.debug("Scheduler tick", { scheduleCount: schedules.length, now: now.toISOString() });

  for (const row of schedules) {
    const schedule = rowToSchedule(row);

    const localNow = dateInTimezone(now, schedule.timezone);

    if (cronMatchesDate(schedule.cronExpression, localNow)) {
      if (schedule.lastRunAt) {
        const lastRunMinuteAgo = (now.getTime() - schedule.lastRunAt) < 90_000;
        if (lastRunMinuteAgo) {
          logger.debug("Schedule already ran this minute, skipping", { id: schedule.id });
          continue;
        }
      }

      logger.info("Schedule matched, executing", { id: schedule.id, cron: schedule.cronExpression });
      executeSchedule(schedule).catch((err) => {
        logger.error("executeSchedule unhandled error", { id: schedule.id, error: String(err) });
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------

let tickInterval: ReturnType<typeof setInterval> | null = null;

export function startScheduler(): void {
  if (tickInterval) return;

  logger.info("Scheduler started", { intervalMs: schedulerTickMs, timezone: schedulerTimezone });

  // Run first tick after a short delay (let server fully boot)
  setTimeout(() => tick(), 5_000);

  tickInterval = setInterval(() => tick(), schedulerTickMs);
}

export function stopScheduler(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
    logger.info("Scheduler stopped");
  }
}

// ---------------------------------------------------------------------------
// Schedule command handler (called from orchestrator)
// ---------------------------------------------------------------------------

export interface ScheduleCommandContext {
  userName: string;
  userId: string;
  channelId: string;
  platform: string;
  /** Discord mentions in the message: array of { id, username } */
  mentions?: Array<{ id: string; username: string }>;
}

/**
 * Handle schedule commands. Returns a response string, "ASYNC" for async ops,
 * or null if the input wasn't a schedule command.
 */
export function handleScheduleCommand(
  text: string,
  ctx: ScheduleCommandContext,
  sendFn: (text: string) => Promise<void>,
): string | null {
  const trimmed = text.trim();

  if (/^schedules$/i.test(trimmed)) {
    return formatScheduleList(ctx.channelId);
  }

  const match = trimmed.match(/^schedule\s+(.+)$/i);
  if (!match) return null;

  const rest = match[1]!.trim();
  const parts = rest.split(/\s+/);
  const subcommand = parts[0]?.toLowerCase();

  if (!subcommand) return null;

  if (subcommand === "list") {
    return formatScheduleList(ctx.channelId);
  }

  if (subcommand === "delete" || subcommand === "remove") {
    const id = parts[1];
    if (!id) return "Usage: `schedule delete <id>`";
    const removed = removeSchedule(id);
    return removed
      ? `🗑️ Schedule \`${id}\` deleted.`
      : `Schedule \`${id}\` not found.`;
  }

  if (subcommand === "pause" || subcommand === "disable") {
    const id = parts[1];
    if (!id) return "Usage: `schedule pause <id>`";
    const ok = setScheduleEnabled(id, false);
    return ok
      ? `⏸️ Schedule \`${id}\` paused.`
      : `Schedule \`${id}\` not found.`;
  }

  if (subcommand === "resume" || subcommand === "enable") {
    const id = parts[1];
    if (!id) return "Usage: `schedule resume <id>`";
    const ok = setScheduleEnabled(id, true);
    return ok
      ? `▶️ Schedule \`${id}\` resumed.`
      : `Schedule \`${id}\` not found.`;
  }

  if (subcommand === "add" || subcommand === "create" || subcommand === "once") {
    const rawInput = parts.slice(1).join(" ");
    if (!rawInput) {
      return "Usage: `schedule add <when and what>`\nExample: `schedule add every weekday at 8am summarize my inbox`";
    }

    const fullInput = subcommand === "once" ? `(one-time) ${rawInput}` : rawInput;

    handleScheduleAdd(fullInput, ctx, sendFn).catch((err) => {
      logger.error("Schedule add failed", { error: String(err) });
      sendFn(`❌ Failed to create schedule: ${String(err)}`).catch(() => {});
    });

    return "ASYNC";
  }

  return [
    "**📅 Schedule Commands**",
    "",
    "`schedule add <when and what>`",
    "  Create a recurring scheduled task (natural language)",
    "",
    "`schedule once <when and what>`",
    "  Create a one-time task (auto-disables after running)",
    "",
    "`schedule list` or `schedules`",
    "  List all schedules in this channel",
    "",
    "`schedule delete <id>`",
    "  Delete a schedule",
    "",
    "`schedule pause <id>` / `schedule resume <id>`",
    "  Pause or resume a schedule",
    "",
    "**Examples:**",
    "`schedule add every weekday at 8am summarize my inbox`",
    "`schedule add setiap hari jam 9 pagi cek system health`",
    "`schedule once jam 8 malam send reminder meeting besok`",
    "`schedule add every 30 minutes give me a status update`",
  ].join("\n");
}

async function handleScheduleAdd(
  rawInput: string,
  ctx: ScheduleCommandContext,
  sendFn: (text: string) => Promise<void>,
): Promise<void> {
  await sendFn("🔍 Parsing your schedule...");

  const parsed = await parseScheduleWithClaude(rawInput);

  let notifyUserId: string | null = null;
  let notifyUserName: string | null = null;

  if (parsed.notifyTarget) {
    if (parsed.notifyTarget === "self") {
      notifyUserId = ctx.userId;
      notifyUserName = ctx.userName;
      logger.info("Notify target: self", { notifyUserId, notifyUserName });
    } else {
      // Try to match against mentions in the message
      const mentions = ctx.mentions || [];
      const target = parsed.notifyTarget.toLowerCase();
      const matched = mentions.find(
        (m) => m.username.toLowerCase().includes(target) || target.includes(m.username.toLowerCase()),
      );

      if (matched) {
        notifyUserId = matched.id;
        notifyUserName = matched.username;
        logger.info("Matched notify target from mention", { notifyUserId, notifyUserName });
      } else {
        notifyUserName = parsed.notifyTarget;
        logger.warn("Could not resolve notify target — will attempt at runtime", { target: parsed.notifyTarget });
      }
    }
  }

  const schedule = createSchedule(
    ctx.channelId,
    ctx.platform,
    parsed.cronExpression,
    parsed.prompt,
    ctx.userName,
    ctx.userId,
    { recurring: parsed.recurring, directMessage: parsed.directMessage, notifyUserId, notifyUserName },
  );

  const desc = describeCron(parsed.cronExpression);
  const next = nextRunTime(parsed.cronExpression, schedule.timezone);
  const nextStr = next
    ? next.toLocaleString("en-US", { timeZone: schedule.timezone, dateStyle: "medium", timeStyle: "short" })
    : "—";
  const typeLabel = schedule.recurring ? "🔁 Recurring" : "1️⃣ One-time";
  const modeLabel = schedule.directMessage ? "✉️ Direct message" : "🤖 Claude task";
  let notifyLabel: string;
  if (notifyUserId && notifyUserName) {
    notifyLabel = `💬 Notify: ${notifyUserName} ✅`;
  } else if (notifyUserName) {
    notifyLabel = `💬 Notify: ${notifyUserName} ⚠️ (not resolved yet)`;
  } else {
    notifyLabel = "💬 Notify: post in this channel";
  }

  const reply = [
    `✅ **Schedule created!**`,
    `🆔 \`${schedule.id}\``,
    `⏰ \`${parsed.cronExpression}\` — ${desc}`,
    `📝 ${parsed.prompt}`,
    `${typeLabel} | ${modeLabel}`,
    `${notifyLabel}`,
    `🌏 Timezone: ${schedule.timezone}`,
    `▶️ Next run: ${nextStr}`,
  ].join("\n");

  await sendFn(reply);
}

function formatScheduleList(channelId: string): string {
  const schedules = listSchedulesByChannel(channelId);

  if (schedules.length === 0) {
    return "📅 No schedules in this channel.\n\nCreate one with:\n`schedule add every weekday at 8am Your prompt here`";
  }

  const lines = schedules.map((s) => {
    const status = s.enabled ? "▶️" : "⏸️";
    const typeTag = s.recurring ? "🔁" : "1️⃣";
    const desc = describeCron(s.cronExpression);
    const lastRun = s.lastRunAt
      ? new Date(s.lastRunAt).toLocaleString("en-US", { timeZone: s.timezone, dateStyle: "short", timeStyle: "short" })
      : "never";
    const next = s.enabled ? nextRunTime(s.cronExpression, s.timezone) : null;
    const nextStr = next
      ? next.toLocaleString("en-US", { timeZone: s.timezone, dateStyle: "short", timeStyle: "short" })
      : "—";

    const notifyTag = s.notifyUserName ? `→ 💬 ${s.notifyUserName}` : "";

    return [
      `${status} ${typeTag} \`${s.id}\` — \`${s.cronExpression}\` ${notifyTag}`,
      `   ${desc}`,
      `   📝 ${s.prompt.slice(0, 100)}${s.prompt.length > 100 ? "…" : ""}`,
      `   Last: ${lastRun} | Next: ${nextStr}`,
      `   By: ${s.createdBy}`,
    ].join("\n");
  });

  return `**📅 Schedules (${schedules.length})**\n\n${lines.join("\n\n")}`;
}
