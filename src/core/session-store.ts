import { RedisClient } from "bun";
import { logger } from "../utils/logger";

export interface Session {
  sessionId: string;
  isNew: boolean;
}

const KEY_PREFIX = "session:";

export class SessionStore {
  private redis: RedisClient;
  private ttlSeconds: number;

  constructor(redisUrl: string, ttlMinutes: number) {
    this.redis = new RedisClient(redisUrl);
    this.ttlSeconds = ttlMinutes * 60;
  }

  private makeKey(platform: string, sessionKey: string): string {
    return `${KEY_PREFIX}${platform}:${sessionKey}`;
  }

  async get(platform: string, sessionKey: string): Promise<Session> {
    const key = this.makeKey(platform, sessionKey);
    const data = await this.redis.get(key);

    if (data) {
      await this.redis.expire(key, this.ttlSeconds);
      const sessionId = JSON.parse(data).sessionId as string;
      return { sessionId, isNew: false };
    }

    const sessionId = crypto.randomUUID();
    await this.redis.set(key, JSON.stringify({ sessionId }), "EX", this.ttlSeconds);
    logger.debug(`New session created: ${key} -> ${sessionId}`);
    return { sessionId, isNew: true };
  }

  async reset(platform: string, sessionKey: string): Promise<void> {
    const key = this.makeKey(platform, sessionKey);
    await this.redis.del(key);
    logger.debug(`Session reset: ${key}`);
  }

  destroy(): void {
    this.redis.close();
  }
}
