import type { Config } from "../config";
import type { InboundMessage, ReplySender, StreamingReplierFactory } from "../types/channel";
import type { SessionRegistry } from "../approval/session-registry";
import { ClaudeBridge, type AgentBridge } from "./claude-bridge";
import { CodexBridge } from "./codex-bridge";
import { SessionStore } from "./session-store";
import { logger } from "../utils/logger";
import { handleScheduleCommand, type ScheduleCommandContext } from "../services/scheduler";

/** Extract the Discord channel ID from a sessionKey. */
function toDiscordChannelId(sessionKey: string): string {
  // DM sessions use "dm:{channelId}", threads use the thread ID directly
  return sessionKey.startsWith("dm:") ? sessionKey.slice(3) : sessionKey;
}

const IMAGE_PATH_RE = /(?:^|\s)(\/[^\s]+\.(?:png|jpg|jpeg|gif|webp|svg))(?:\s|$|[)\].,])/gim;

async function extractExistingImagePaths(text: string): Promise<string[]> {
  const paths: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = IMAGE_PATH_RE.exec(text)) !== null) {
    const filePath = match[1]!;
    try {
      if (await Bun.file(filePath).exists()) {
        paths.push(filePath);
      }
    } catch {}
  }
  return [...new Set(paths)];
}

export class Orchestrator {
  private bridge: AgentBridge;
  private sessions: SessionStore;
  private registry: SessionRegistry;
  private provider: Config["provider"];
  /** Track in-flight requests per session to prevent double-sends. */
  private inFlight = new Set<string>();

  /** Expose the selected bridge for scheduled agent tasks. */
  getBridge(): AgentBridge {
    return this.bridge;
  }

  constructor(config: Config, registry: SessionRegistry) {
    this.bridge = config.provider === "codex" ? new CodexBridge({
      maxConcurrent: config.maxConcurrentClaude,
      model: config.codexModel,
      reasoningEffort: config.codexReasoningEffort,
      workDir: config.codexWorkDir,
      codexCodePath: config.codexCodePath,
      approvalPort: config.approvalServerPort,
      approvalPolicy: config.codexApprovalPolicy,
      sandbox: config.codexSandbox,
      timeoutMs: config.codexTimeoutMs,
    }) : new ClaudeBridge({
      maxConcurrent: config.maxConcurrentClaude,
      model: config.claudeModel,
      maxTurns: config.claudeMaxTurns,
      workDir: config.claudeWorkDir,
      claudeCodePath: config.claudeCodePath,
    });
    this.sessions = new SessionStore(config.sessionTtlMinutes);
    this.registry = registry;
    this.provider = config.provider;
  }

  async handle(msg: InboundMessage, reply: ReplySender, createStreamer?: StreamingReplierFactory): Promise<void> {
    const { context, text } = msg;
    const flightKey = `${context.platform}:${context.sessionKey}`;
    const storedSessionKey = this.provider === "codex" ? `codex:${context.sessionKey}` : context.sessionKey;

    // Handle special commands
    if (text.trim().toLowerCase() === "/reset") {
      await this.sessions.reset(context.platform, storedSessionKey);
      await reply("Session reset. Starting fresh conversation.");
      return;
    }

    // Handle schedule commands
    const scheduleCtx: ScheduleCommandContext = {
      userName: context.userName,
      userId: context.userId,
      channelId: context.channelId,
      platform: context.platform,
      mentions: msg.mentions,
    };

    const scheduleResult = handleScheduleCommand(text, scheduleCtx, (t) => reply(t));
    if (scheduleResult === "ASYNC") return;
    if (scheduleResult) {
      await reply(scheduleResult);
      return;
    }

    const requestedImagePaths = await extractExistingImagePaths(text);
    if (requestedImagePaths.length > 0 && /\b(?:kirim|send|share|upload|tampil|tampilkan|gambar|image|screenshot)\b/i.test(text)) {
      await reply("", requestedImagePaths);
      return;
    }

    if (this.inFlight.has(flightKey)) {
      await reply("I'm still processing a message in this conversation. Please wait.");
      return;
    }

    this.inFlight.add(flightKey);

    try {
      const session = await this.sessions.get(context.platform, storedSessionKey);

      // Map the provider session ID to the Discord channel so approvals land here
      if (context.platform === "discord") {
        this.registry.register(session.sessionId, toDiscordChannelId(context.sessionKey));
      }

      logger.info(`[${context.platform}] ${context.userName}: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""} (${msg.attachments?.length ?? 0} images)`);

      // Set up streaming if the channel supports it
      const streamer = createStreamer?.();

      const response = await this.bridge.ask(
        text,
        session.sessionId,
        session.isNew,
        msg.attachments,
        streamer
          ? {
              onTextDelta: (delta) => streamer.onDelta(delta),
              onStreamEnd: () => streamer.flush(),
            }
          : undefined,
      );

      if (response.sessionId !== session.sessionId) {
        await this.sessions.setSessionId(context.platform, storedSessionKey, response.sessionId);
      }

      logger.info(`[${context.platform}] Reply to ${context.userName}: ${response.text.slice(0, 100)}${response.text.length > 100 ? "..." : ""} (${response.imageFiles.length} images)`);

      // If we streamed, only send images (text was already streamed).
      // If not streaming, send the full response.
      if (streamer && response.imageFiles.length) {
        await reply("", response.imageFiles);
      } else if (!streamer) {
        await reply(response.text, response.imageFiles);
      }
    } catch (err) {
      logger.error(`Error handling message from ${context.userName}:`, err);
      await reply("Sorry, something went wrong processing your message. Please try again.");
    } finally {
      this.inFlight.delete(flightKey);
    }
  }

  destroy(): void {
    this.sessions.destroy();
    this.bridge.destroy?.();
  }
}
