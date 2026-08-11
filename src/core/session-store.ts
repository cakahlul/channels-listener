import { db } from "../db/database";
import { logger } from "../utils/logger";

export interface Session {
  sessionId: string;
  isNew: boolean;
}

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export class SessionStore {
  private ttlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval>;

  private selectStmt = db.query<
    { session_id: string; expires_at: number },
    [string, string]
  >("SELECT session_id, expires_at FROM sessions WHERE platform = ? AND session_key = ?");

  private upsertStmt = db.query(
    `INSERT INTO sessions (platform, session_key, session_id, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(platform, session_key) DO UPDATE SET
       session_id = excluded.session_id,
       expires_at = excluded.expires_at`,
  );

  private touchStmt = db.query(
    "UPDATE sessions SET expires_at = ? WHERE platform = ? AND session_key = ?",
  );

  private updateSessionIdStmt = db.query(
    "UPDATE sessions SET session_id = ? WHERE platform = ? AND session_key = ?",
  );

  private deleteStmt = db.query(
    "DELETE FROM sessions WHERE platform = ? AND session_key = ?",
  );

  private purgeStmt = db.query("DELETE FROM sessions WHERE expires_at <= ?");

  constructor(ttlMinutes: number) {
    this.ttlMs = ttlMinutes * 60 * 1000;
    this.purgeExpired();
    this.cleanupTimer = setInterval(() => this.purgeExpired(), CLEANUP_INTERVAL_MS);
  }

  async get(platform: string, sessionKey: string): Promise<Session> {
    const now = Date.now();
    const row = this.selectStmt.get(platform, sessionKey);

    if (row && row.expires_at > now) {
      this.touchStmt.run(now + this.ttlMs, platform, sessionKey);
      return { sessionId: row.session_id, isNew: false };
    }

    const sessionId = crypto.randomUUID();
    this.upsertStmt.run(platform, sessionKey, sessionId, now + this.ttlMs);
    logger.debug(`New session created: ${platform}:${sessionKey} -> ${sessionId}`);
    return { sessionId, isNew: true };
  }

  async reset(platform: string, sessionKey: string): Promise<void> {
    this.deleteStmt.run(platform, sessionKey);
    logger.debug(`Session reset: ${platform}:${sessionKey}`);
  }

  async setSessionId(platform: string, sessionKey: string, sessionId: string): Promise<void> {
    this.updateSessionIdStmt.run(sessionId, platform, sessionKey);
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
  }

  private purgeExpired(): void {
    const res = this.purgeStmt.run(Date.now());
    if (res.changes > 0) {
      logger.debug(`Purged ${res.changes} expired session(s)`);
    }
  }
}
