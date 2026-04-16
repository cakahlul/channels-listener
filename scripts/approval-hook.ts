#!/usr/bin/env bun
/**
 * Claude Code hook script for forwarding approval requests to Discord.
 *
 * This script is invoked by Claude Code's PermissionRequest hook.
 * It reads the hook JSON from stdin, POSTs it to the approval server,
 * and outputs the decision JSON to stdout.
 *
 * Exit codes:
 *   0 + JSON stdout → decision is applied (allow/deny)
 *   2 + stderr      → block the action with reason
 *   1              → error, action proceeds (non-blocking)
 */

const APPROVAL_SERVER_URL = process.env.APPROVAL_SERVER_URL || "http://localhost:7842";

async function main() {
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
    console.error("No input received on stdin");
    process.exit(1);
  }

  let hookInput: Record<string, unknown>;
  try {
    hookInput = JSON.parse(raw);
  } catch {
    console.error("Failed to parse stdin JSON");
    process.exit(1);
  }

  // POST to the approval server and wait for the decision
  try {
    const res = await fetch(`${APPROVAL_SERVER_URL}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(hookInput),
    });

    if (!res.ok) {
      console.error(`Approval server returned ${res.status}`);
      process.exit(1);
    }

    const result = (await res.json()) as { decision: string; decidedBy: string };

    // Output the hook response JSON for Claude Code (PermissionRequest format)
    const hookResponse = {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: result.decision === "allow" ? "allow" : "deny",
        },
      },
    };

    console.log(JSON.stringify(hookResponse));
    process.exit(0);
  } catch (err) {
    console.error(`Failed to reach approval server: ${err}`);
    // Exit 1 = non-blocking error, action proceeds as normal
    // This prevents the hook from blocking Claude if the server is down
    process.exit(1);
  }
}

main();
