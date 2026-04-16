const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

let currentLevel: Level = "info";

export function setLogLevel(level: string) {
  if (level in LEVELS) currentLevel = level as Level;
}

function log(level: Level, ...args: unknown[]) {
  if (LEVELS[level] >= LEVELS[currentLevel]) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
    console[level === "debug" ? "log" : level](prefix, ...args);
  }
}

export const logger = {
  debug: (...args: unknown[]) => log("debug", ...args),
  info: (...args: unknown[]) => log("info", ...args),
  warn: (...args: unknown[]) => log("warn", ...args),
  error: (...args: unknown[]) => log("error", ...args),
};
