import { Database } from "bun:sqlite";
import { logger } from "../utils/logger";

const dbPath = process.env.DB_PATH || "channels-listener.sqlite";

logger.debug("Initializing SQLite database", { dbPath });

const db = new Database(dbPath, { create: true });

// WAL mode for better concurrent read/write performance
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");

db.run(`
  CREATE TABLE IF NOT EXISTS schedules (
    id                TEXT    PRIMARY KEY,
    channel_id        TEXT    NOT NULL,
    platform          TEXT    NOT NULL DEFAULT 'discord',
    cron_expression   TEXT    NOT NULL,
    prompt            TEXT    NOT NULL,
    timezone          TEXT    NOT NULL DEFAULT 'Asia/Jakarta',
    created_by        TEXT    NOT NULL,
    created_by_id     TEXT    NOT NULL,
    recurring         INTEGER NOT NULL DEFAULT 1,
    direct_message    INTEGER NOT NULL DEFAULT 0,
    notify_user_id    TEXT,
    notify_user_name  TEXT,
    enabled           INTEGER NOT NULL DEFAULT 1,
    last_run_at       INTEGER,
    created_at        INTEGER NOT NULL,
    execution_mode    TEXT    NOT NULL DEFAULT 'task',
    command           TEXT
  )
`);

// Idempotent column adds for pre-existing DBs.
const existingCols = new Set(
  (db.query("PRAGMA table_info(schedules)").all() as Array<{ name: string }>).map((r) => r.name),
);
if (!existingCols.has("execution_mode")) {
  db.run("ALTER TABLE schedules ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'task'");
}
if (!existingCols.has("command")) {
  db.run("ALTER TABLE schedules ADD COLUMN command TEXT");
}

db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    platform     TEXT    NOT NULL,
    session_key  TEXT    NOT NULL,
    session_id   TEXT    NOT NULL,
    expires_at   INTEGER NOT NULL,
    PRIMARY KEY (platform, session_key)
  )
`);
db.run("CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)");

logger.debug("Database initialization complete");

export { db };
