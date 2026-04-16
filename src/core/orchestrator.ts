import type { Config } from "../config";
import type { InboundMessage, ReplySender } from "../types/channel";
import { ClaudeBridge } from "./claude-bridge";
import { SessionStore } from "./session-store";
import { logger } from "../utils/logger";

export class Orchestrator {
  private bridge: ClaudeBridge;
  private sessions: SessionStore;
  /** Track in-flight requests per session to prevent double-sends. */
  private inFlight = new Set<string>();

  constructor(config: Config) {
    this.bridge = new ClaudeBridge({
      maxConcurrent: config.maxConcurrentClaude,
      model: config.claudeModel,
      maxTurns: config.claudeMaxTurns,
      workDir: config.claudeWorkDir,
    });
    this.sessions = new SessionStore(config.redisUrl, config.sessionTtlMinutes);
  }

  async handle(msg: InboundMessage, reply: ReplySender): Promise<void> {
    const { context, text } = msg;
    const flightKey = `${context.platform}:${context.sessionKey}`;

    // Handle special commands
    if (text.trim().toLowerCase() === "/reset") {
      await this.sessions.reset(context.platform, context.sessionKey);
      await reply("Session reset. Starting fresh conversation.");
      return;
    }

    if (this.inFlight.has(flightKey)) {
      await reply("I'm still processing a message in this conversation. Please wait.");
      return;
    }

    this.inFlight.add(flightKey);

    try {
      const session = await this.sessions.get(context.platform, context.sessionKey);

      logger.info(`[${context.platform}] ${context.userName}: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);

      const response = await this.bridge.ask(text, session.sessionId, session.isNew);

      logger.info(`[${context.platform}] Reply to ${context.userName}: ${response.slice(0, 100)}${response.length > 100 ? "..." : ""}`);

      await reply(response);
    } catch (err) {
      logger.error(`Error handling message from ${context.userName}:`, err);
      await reply("Sorry, something went wrong processing your message. Please try again.");
    } finally {
      this.inFlight.delete(flightKey);
    }
  }

  destroy(): void {
    this.sessions.destroy();
  }
}
