export interface Config {
  provider: "claude" | "codex";
  discordBotToken: string;
  googleChatEnabled: boolean;
  googleChatCredentialsPath: string;
  googleChatWebhookPort: number;
  googleChatVerificationToken?: string;
  claudeWorkDir: string;
  claudeModel: string;
  claudeMaxTurns: number;
  claudeCodePath?: string;
  codexCodePath?: string;
  codexModel: string;
  codexWorkDir: string;
  codexApprovalPolicy?: "untrusted" | "on-request" | "never";
  codexSandbox?: "read-only" | "workspace-write" | "danger-full-access";
  codexTimeoutMs: number;
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

  const codexApprovalPolicy = process.env.CODEX_APPROVAL_POLICY;
  const codexSandbox = process.env.CODEX_SANDBOX;

  return {
    provider: process.env.PROVIDER === "codex" ? "codex" : "claude",
    discordBotToken,
    googleChatEnabled: process.env.GOOGLE_CHAT_ENABLED === "true",
    googleChatCredentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS || "./credentials.json",
    googleChatWebhookPort: parseInt(process.env.GOOGLE_CHAT_WEBHOOK_PORT || "7843", 10),
    googleChatVerificationToken: process.env.GOOGLE_CHAT_VERIFICATION_TOKEN,
    claudeWorkDir: process.env.CLAUDE_WORK_DIR || process.cwd(),
    claudeModel: process.env.CLAUDE_MODEL || "sonnet",
    claudeMaxTurns: parseInt(process.env.CLAUDE_MAX_TURNS || "25", 10),
    claudeCodePath: process.env.CLAUDE_CODE_PATH,
    codexCodePath: process.env.CODEX_PATH,
    codexModel: process.env.CODEX_MODEL || "gpt-5",
    codexWorkDir: process.env.CODEX_WORK_DIR || process.env.CLAUDE_WORK_DIR || process.cwd(),
    codexApprovalPolicy: codexApprovalPolicy === "untrusted" || codexApprovalPolicy === "on-request" || codexApprovalPolicy === "never" ? codexApprovalPolicy : undefined,
    codexSandbox: codexSandbox === "read-only" || codexSandbox === "workspace-write" || codexSandbox === "danger-full-access" ? codexSandbox : undefined,
    codexTimeoutMs: parseInt(process.env.CODEX_TIMEOUT_MS || "600000", 10),
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
