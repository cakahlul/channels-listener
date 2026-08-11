const CODEX_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type CodexReasoningEffort = typeof CODEX_REASONING_EFFORTS[number];

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
  codexModel?: string;
  codexReasoningEffort?: CodexReasoningEffort;
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
  const codexReasoningEffort = process.env.CODEX_REASONING_EFFORT;
  const provider = process.env.PROVIDER || "claude";
  const codexTimeoutMs = Number(process.env.CODEX_TIMEOUT_MS || "600000");
  if (provider !== "claude" && provider !== "codex") {
    throw new Error("PROVIDER must be claude or codex");
  }
  if (codexApprovalPolicy !== undefined && codexApprovalPolicy !== "untrusted" && codexApprovalPolicy !== "on-request" && codexApprovalPolicy !== "never") {
    throw new Error("CODEX_APPROVAL_POLICY must be untrusted, on-request, or never");
  }
  if (codexSandbox !== undefined && codexSandbox !== "read-only" && codexSandbox !== "workspace-write" && codexSandbox !== "danger-full-access") {
    throw new Error("CODEX_SANDBOX must be read-only, workspace-write, or danger-full-access");
  }
  if (codexReasoningEffort !== undefined && !CODEX_REASONING_EFFORTS.includes(codexReasoningEffort as CodexReasoningEffort)) {
    throw new Error(`CODEX_REASONING_EFFORT must be ${CODEX_REASONING_EFFORTS.join(", ")}`);
  }
  if (!Number.isInteger(codexTimeoutMs) || codexTimeoutMs <= 0) {
    throw new Error("CODEX_TIMEOUT_MS must be a positive integer");
  }

  return {
    provider,
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
    codexModel: process.env.CODEX_MODEL || undefined,
    codexReasoningEffort: codexReasoningEffort as CodexReasoningEffort | undefined,
    codexWorkDir: process.env.CODEX_WORK_DIR || process.env.CLAUDE_WORK_DIR || process.cwd(),
    codexApprovalPolicy,
    codexSandbox,
    codexTimeoutMs,
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
