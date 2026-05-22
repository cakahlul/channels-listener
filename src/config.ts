export interface Config {
  discordBotToken: string;
  claudeWorkDir: string;
  claudeModel: string;
  claudeMaxTurns: number;
  claudeCodePath?: string;
  sessionTtlMinutes: number;
  maxConcurrentClaude: number;
  logLevel: string;
  approvalFallbackChannelId?: string;
  approvalServerPort: number;
  approvalTimeoutMs: number;
  dbPath: string;
  schedulerTimezone: string;
  schedulerTickMs: number;
  schedulerShellTimeoutMs: number;
  confirmTimeoutMs: number;
}

export function loadConfig(): Config {
  const discordBotToken = process.env.DISCORD_BOT_TOKEN;
  if (!discordBotToken) {
    throw new Error("DISCORD_BOT_TOKEN is required");
  }

  return {
    discordBotToken,
    claudeWorkDir: process.env.CLAUDE_WORK_DIR || process.cwd(),
    claudeModel: process.env.CLAUDE_MODEL || "sonnet",
    claudeMaxTurns: parseInt(process.env.CLAUDE_MAX_TURNS || "25", 10),
    claudeCodePath: process.env.CLAUDE_CODE_PATH,
    sessionTtlMinutes: parseInt(process.env.SESSION_TTL_MINUTES || "60", 10),
    maxConcurrentClaude: parseInt(process.env.MAX_CONCURRENT_CLAUDE || "5", 10),
    logLevel: process.env.LOG_LEVEL || "info",
    approvalFallbackChannelId: process.env.APPROVAL_FALLBACK_CHANNEL_ID,
    approvalServerPort: parseInt(process.env.APPROVAL_SERVER_PORT || "7842", 10),
    approvalTimeoutMs: parseInt(process.env.APPROVAL_TIMEOUT_MS || "300000", 10),
    dbPath: process.env.DB_PATH || "channels-listener.sqlite",
    schedulerTimezone: process.env.SCHEDULER_TIMEZONE || "Asia/Jakarta",
    schedulerTickMs: parseInt(process.env.SCHEDULER_TICK_MS || "60000", 10),
    schedulerShellTimeoutMs: parseInt(process.env.SCHEDULER_SHELL_TIMEOUT_MS || "600000", 10),
    confirmTimeoutMs: parseInt(process.env.CONFIRM_TIMEOUT_MS || "300000", 10),
  };
}
