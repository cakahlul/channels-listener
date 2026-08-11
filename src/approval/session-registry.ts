import { logger } from "../utils/logger";

/**
 * Maps provider session IDs to Discord channel IDs so that
 * approval prompts land in the same thread/DM the conversation lives in.
 */
export class SessionRegistry {
  /** provider_session_id → discord_channel_id */
  private map = new Map<string, string>();

  register(claudeSessionId: string, discordChannelId: string): void {
    this.map.set(claudeSessionId, discordChannelId);
    logger.debug(`[session-registry] ${claudeSessionId} → ${discordChannelId}`);
  }

  resolve(claudeSessionId: string): string | undefined {
    return this.map.get(claudeSessionId);
  }

  remove(claudeSessionId: string): void {
    this.map.delete(claudeSessionId);
  }
}
