#!/usr/bin/env bun
/**
 * Claude Code hook script for forwarding approval requests to Discord.
 *
 * Read-only operations are auto-allowed without asking Discord.
 * Only destructive/mutating operations require Discord approval.
 *
 * Exit codes:
 *   0 + JSON stdout → decision is applied (allow/deny)
 *   2 + stderr      → block the action with reason
 *   1              → error, action proceeds (non-blocking)
 */

const APPROVAL_SERVER_URL = process.env.APPROVAL_SERVER_URL || "http://localhost:7842";
const LOG_FILE = process.env.APPROVAL_HOOK_LOG || "/tmp/approval-hook.log";

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    Bun.file(LOG_FILE);
    const fs = require("fs");
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

// Tools that are inherently read-only — never need Discord approval
const AUTO_ALLOW_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "ToolSearch",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
]);

// MCP tool name substrings that indicate a read-only operation
const READ_ONLY_MCP_PATTERNS = [
  "get", "list", "search", "read", "view", "fetch",
  "describe", "suggest", "lookup", "info",
];

// Bash command prefixes that are read-only (checked after stripping env vars)
const READ_ONLY_BASH_PREFIXES = [
  // git read-only (status/log/diff auto-allowed by Claude Code, but extras here for safety)
  "git show", "git blame", "git ls-files", "git ls-remote",
  "git stash list", "git describe", "git rev-parse", "git cat-file",
  "git for-each-ref", "git worktree list", "git reflog", "git shortlog",
  // pm2 read-only
  "pm2 status", "pm2 list", "pm2 logs", "pm2 info", "pm2 show",
  // process/system info
  "journalctl", "systemctl status",
  "kubectl get", "kubectl describe", "kubectl logs",
  "docker ps", "docker images", "docker logs", "docker inspect",
  // package info
  "npm list", "bun pm ls", "pip list", "pip show",
];

function isReadOnlyBash(command: string): boolean {
  const cmd = command.trim().replace(/^([A-Z_]+=\S+\s+)+/, "");

  // Explicit destructive patterns — always require approval even if prefix matches
  const destructivePatterns = [
    /\brm\s/,
    /\bgit\s+(push|reset|rebase|merge|cherry-pick|clean|branch\s+-[Dd])\b/,
    /\bgit\s+commit\b/,
    /\bpm2\s+(start|stop|restart|reload|delete|kill)\b/,
    /\bsystemctl\s+(start|stop|restart|enable|disable)\b/,
    /\bkubectl\s+(apply|delete|scale|rollout|patch|create|replace)\b/,
    /\bdocker\s+(run|exec|rm|rmi|build|push|kill|stop|start)\b/,
    /\b(apt|apt-get|yum|dnf|brew)\s+(install|remove|purge|upgrade)\b/,
    /\b(npm|bun|yarn|pnpm)\s+(install|add|remove|uninstall|update)\b/,
    /\bmkdir\b/, /\bmv\b/, /\bcp\b/, /\bchmod\b/, /\bchown\b/,
    /\btee\b/, /\btruncate\b/,
    />[^>]/, // single redirect (write), but not >> (append)
  ];

  if (destructivePatterns.some((p) => p.test(cmd))) return false;

  return READ_ONLY_BASH_PREFIXES.some(
    (prefix) => cmd.startsWith(prefix) || command.trim().startsWith(prefix)
  );
}

function isAutoAllow(toolName: string, input: Record<string, unknown>): boolean {
  if (AUTO_ALLOW_TOOLS.has(toolName)) return true;

  if (toolName.startsWith("mcp__")) return true;

  if (toolName === "Bash") {
    const command = (input.command as string) || "";
    if (isReadOnlyBash(command)) return true;
  }

  return false;
}

function autoAllowResponse(reason: string) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: reason,
    },
  });
}

async function main() {
  const chunks: string[] = [];
  const reader = Bun.stdin.stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(new TextDecoder().decode(value));
  }

  const raw = chunks.join("");
  if (!raw.trim()) {
    log("ERROR: No input on stdin");
    process.exit(1);
  }

  let hookInput: Record<string, unknown>;
  try {
    hookInput = JSON.parse(raw);
  } catch {
    log("ERROR: Failed to parse stdin JSON");
    process.exit(1);
  }

  const toolName = (hookInput.tool_name as string) ?? "unknown";
  const input = (hookInput.input as Record<string, unknown>) ?? {};
  const sessionId = hookInput.session_id ?? "unknown";

  if (isAutoAllow(toolName, input)) {
    log(`Auto-allowed: tool=${toolName}`);
    console.log(autoAllowResponse("Read-only operation, no approval needed"));
    process.exit(0);
  }

  log(`Needs Discord approval: tool=${toolName}, session=${sessionId}`);

  try {
    const res = await fetch(`${APPROVAL_SERVER_URL}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(hookInput),
    });

    if (!res.ok) {
      log(`ERROR: Approval server returned ${res.status}`);
      process.exit(1);
    }

    const result = (await res.json()) as { decision: string; decidedBy: string };
    log(`Decision: ${result.decision} by ${result.decidedBy}`);

    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: result.decision === "allow" ? "allow" : "deny",
          permissionDecisionReason: `${result.decision === "allow" ? "Approved" : "Denied"} via Discord by ${result.decidedBy}`,
        },
      })
    );
    process.exit(0);
  } catch (err) {
    log(`ERROR: Failed to reach approval server: ${err}`);
    process.exit(1); // Non-blocking — action proceeds if server is down
  }
}

main();
