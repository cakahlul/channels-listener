import { logger } from "../utils/logger";
import type { ApprovalHandler, ApprovalRequest } from "./handler";
import type { ConfirmationHandler } from "./confirmation-handler";

/**
 * Starts an HTTP server that receives approval requests from the Claude Code hook script.
 * The hook script POSTs the hook stdin JSON here, and this server forwards it to Discord
 * via the ApprovalHandler, then returns the decision.
 *
 * Also exposes /confirm for ad-hoc Yes/No DM confirmations from external callers
 * (e.g. the clcok-automation bot asking "Clock in now?").
 */
export function startApprovalServer(
  handler: ApprovalHandler,
  port: number,
  opts?: { confirmationHandler?: ConfirmationHandler },
): ReturnType<typeof Bun.serve> {
  const confirmationHandler = opts?.confirmationHandler;
  let counter = 0;

  const server = Bun.serve({
    port,
    routes: {
      "/approval": {
        POST: async (req) => {
          try {
            const body = await req.json() as {
              session_id: string;
              tool_name: string;
              tool_input: Record<string, unknown>;
              hook_event_name: string;
            };

            const requestId = `req_${Date.now()}_${++counter}`;

            const approvalReq: ApprovalRequest = {
              id: requestId,
              sessionId: body.session_id ?? "unknown",
              toolName: body.tool_name ?? "Unknown",
              toolInput: body.tool_input ?? {},
              hookEventName: body.hook_event_name ?? "PreToolUse",
            };

            logger.info(`[approval-server] Received approval request ${requestId} for ${approvalReq.toolName}`);

            const result = await handler.requestApproval(approvalReq);

            logger.info(`[approval-server] Decision for ${requestId}: ${result.decision} by ${result.decidedBy}`);

            return Response.json({
              decision: result.decision,
              decidedBy: result.decidedBy,
            });
          } catch (err) {
            logger.error("[approval-server] Error processing approval:", err);
            return Response.json({ error: "Internal server error" }, { status: 500 });
          }
        },
      },
      "/confirm": {
        POST: async (req) => {
          if (!confirmationHandler) {
            return Response.json({ error: "Confirmation handler not configured" }, { status: 503 });
          }
          try {
            const body = await req.json() as {
              userId?: string;
              prompt?: string;
              title?: string;
              timeoutMs?: number;
            };
            if (!body.userId || !body.prompt) {
              return Response.json({ error: "userId and prompt are required" }, { status: 400 });
            }

            logger.info(`[approval-server] Confirm request → user ${body.userId}: ${body.prompt.slice(0, 80)}`);

            const result = await confirmationHandler.requestConfirmation({
              userId: body.userId,
              prompt: body.prompt,
              title: body.title,
              timeoutMs: body.timeoutMs,
            });

            logger.info(`[approval-server] Confirm decision: ${result.approved ? "yes" : "no"} by ${result.decidedBy}`);

            return Response.json(result);
          } catch (err) {
            logger.error("[approval-server] Error processing confirmation:", err);
            return Response.json({ error: String(err) }, { status: 500 });
          }
        },
      },
      "/health": {
        GET: () => {
          return Response.json({
            status: "ok",
            pendingApprovals: handler.pendingCount,
            pendingConfirmations: confirmationHandler?.pendingCount ?? 0,
          });
        },
      },
    },
  });

  logger.info(`[approval-server] Listening on http://localhost:${port}`);
  return server;
}
