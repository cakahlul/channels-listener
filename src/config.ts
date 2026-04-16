export interface Config {
  discordBotToken: string;
  claudeWorkDir: string;
  claudeModel: string;
  claudeMaxTurns: number;
  redisUrl: string;
  sessionTtlMinutes: number;
  maxConcurrentClaude: number;
  logLevel: string;
}

export function loadConfig(): Config {
  const discordBotToken = process.env.DISCORD_BOT_TOKEN;
  if (!discordBotToken) {
    throw new Error("DISCORD_BOT_TOKEN is required");
  }

  return {
    discordBotToken,
    claudeWorkDir: process.env.CLAUDE_WORK_DIR || process.cwd(),
    redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
    claudeModel: process.env.CLAUDE_MODEL || "sonnet",
    claudeMaxTurns: parseInt(process.env.CLAUDE_MAX_TURNS || "25", 10),
    sessionTtlMinutes: parseInt(process.env.SESSION_TTL_MINUTES || "60", 10),
    maxConcurrentClaude: parseInt(process.env.MAX_CONCURRENT_CLAUDE || "5", 10),
    logLevel: process.env.LOG_LEVEL || "info",
  };
}
