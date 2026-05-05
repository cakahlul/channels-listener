import type { Config } from "../config";
import type { InboundMessage, ReplySender } from "../types/channel";
import type { SessionRegistry } from "../approval/session-registry";
import { ClaudeBridge } from "./claude-bridge";
import { SessionStore } from "./session-store";
import { logger } from "../utils/logger";
import { handleScheduleCommand, type ScheduleCommandContext } from "../services/scheduler";

/** Extract the Discord channel ID from a sessionKey. */
function toDiscordChannelId(sessionKey: string): string {
  // DM sessions use "dm:{channelId}", threads use the thread ID directly
  return sessionKey.startsWith("dm:") ? sessionKey.slice(3) : sessionKey;
}

export class Orchestrator {
  private bridge: ClaudeBridge;
  private sessions: SessionStore;
  private registry: SessionRegistry;
  /** Track in-flight requests per session to prevent double-sends. */
  private inFlight = new Set<string>();

  /** Expose the bridge so the scheduler can invoke Claude. */
  getBridge(): ClaudeBridge {
    return this.bridge;
  }

  constructor(config: Config, registry: SessionRegistry) {
    this.bridge = new ClaudeBridge({
      maxConcurrent: config.maxConcurrentClaude,
      model: config.claudeModel,
      maxTurns: config.claudeMaxTurns,
      workDir: config.claudeWorkDir,
    });
    this.sessions = new SessionStore(config.redisUrl, config.sessionTtlMinutes);
    this.registry = registry;
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

    // Handle schedule commands
    const scheduleCtx: ScheduleCommandContext = {
      userName: context.userName,
      userId: context.userId,
      channelId: context.sessionKey,
      platform: context.platform,
      mentions: msg.mentions,
    };

    const scheduleResult = handleScheduleCommand(text, scheduleCtx, (t) => reply(t));
    if (scheduleResult === "ASYNC") return;
    if (scheduleResult) {
      await reply(scheduleResult);
      return;
    }

    if (this.inFlight.has(flightKey)) {
      await reply("I'm still processing a message in this conversation. Please wait.");
      return;
    }

    this.inFlight.add(flightKey);

    try {
      const session = await this.sessions.get(context.platform, context.sessionKey);

      // Map the Claude session UUID to the Discord channel so approvals land here
      if (context.platform === "discord") {
        this.registry.register(session.sessionId, toDiscordChannelId(context.sessionKey));
      }

      logger.info(`[${context.platform}] ${context.userName}: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""} (${msg.attachments?.length ?? 0} images)`);

      const response = await this.bridge.ask(
        text,
        session.sessionId,
        session.isNew,
        msg.attachments,
      );

      logger.info(`[${context.platform}] Reply to ${context.userName}: ${response.text.slice(0, 100)}${response.text.length > 100 ? "..." : ""} (${response.imageFiles.length} images)`);

      await reply(response.text, response.imageFiles);
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
