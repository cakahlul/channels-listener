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
    created_at        INTEGER NOT NULL
  )
`);

logger.debug("Database initialization complete");

export { db };
