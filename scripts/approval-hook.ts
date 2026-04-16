#!/usr/bin/env bun
/**
 * Claude Code hook script for forwarding approval requests to Discord.
 *
 * This script is invoked by Claude Code's PreToolUse hook.
 * It reads the hook JSON from stdin, POSTs it to the approval server,
 * and outputs the decision JSON to stdout.
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
    const fs = require("fs");
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

async function main() {
  log(`Hook invoked. APPROVAL_SERVER_URL=${APPROVAL_SERVER_URL}`);

  // Read hook input from stdin
  const chunks: string[] = [];
  const reader = Bun.stdin.stream().getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(new TextDecoder().decode(value));
  }

  const raw = chunks.join("");
  if (!raw.trim()) {
    log("ERROR: No input received on stdin");
    console.error("No input received on stdin");
    process.exit(1);
  }

  let hookInput: Record<string, unknown>;
  try {
    hookInput = JSON.parse(raw);
  } catch {
    log("ERROR: Failed to parse stdin JSON");
    console.error("Failed to parse stdin JSON");
    process.exit(1);
  }

  const toolName = hookInput.tool_name ?? "unknown";
  const sessionId = hookInput.session_id ?? "unknown";
  log(`Received: tool=${toolName}, session=${sessionId}`);

  // POST to the approval server and wait for the decision
  try {
    log(`POSTing to ${APPROVAL_SERVER_URL}/approval`);
    const res = await fetch(`${APPROVAL_SERVER_URL}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(hookInput),
    });

    if (!res.ok) {
      log(`ERROR: Approval server returned ${res.status}`);
      console.error(`Approval server returned ${res.status}`);
      process.exit(1);
    }

    const result = (await res.json()) as { decision: string; decidedBy: string };
    log(`Decision: ${result.decision} by ${result.decidedBy}`);

    // Output the hook response JSON for Claude Code (PreToolUse format)
    const hookResponse = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: result.decision === "allow" ? "allow" : "deny",
        permissionDecisionReason: `${result.decision === "allow" ? "Approved" : "Denied"} via Discord by ${result.decidedBy}`,
      },
    };

    console.log(JSON.stringify(hookResponse));
    process.exit(0);
  } catch (err) {
    log(`ERROR: Failed to reach approval server: ${err}`);
    console.error(`Failed to reach approval server: ${err}`);
    // Exit 1 = non-blocking error, action proceeds as normal
    // This prevents the hook from blocking Claude if the server is down
    process.exit(1);
  }
}

main();
