import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

const keys = ["DISCORD_BOT_TOKEN", "PROVIDER", "CODEX_MODEL", "CODEX_REASONING_EFFORT", "CODEX_APPROVAL_POLICY", "CODEX_SANDBOX", "CODEX_TIMEOUT_MS"] as const;
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function codexEnv(): void {
  process.env.DISCORD_BOT_TOKEN = "test";
  process.env.PROVIDER = "codex";
  delete process.env.CODEX_MODEL;
  delete process.env.CODEX_REASONING_EFFORT;
  delete process.env.CODEX_APPROVAL_POLICY;
  delete process.env.CODEX_SANDBOX;
  delete process.env.CODEX_TIMEOUT_MS;
}

describe("loadConfig Codex settings", () => {
  test("uses Codex configured model when CODEX_MODEL is omitted", () => {
    codexEnv();
    expect(loadConfig().codexModel).toBeUndefined();
  });

  test("accepts max Codex reasoning effort", () => {
    codexEnv();
    process.env.CODEX_REASONING_EFFORT = "max";
    expect(loadConfig().codexReasoningEffort).toBe("max");
  });

  test("rejects an invalid Codex reasoning effort", () => {
    codexEnv();
    process.env.CODEX_REASONING_EFFORT = "maximum";
    expect(loadConfig).toThrow("CODEX_REASONING_EFFORT");
  });

  test("rejects invalid security settings", () => {
    codexEnv();
    process.env.CODEX_APPROVAL_POLICY = "always";
    expect(loadConfig).toThrow("CODEX_APPROVAL_POLICY");
  });

  test("rejects an unknown provider", () => {
    codexEnv();
    process.env.PROVIDER = "codeex";
    expect(loadConfig).toThrow("PROVIDER");
  });

  test("rejects a non-positive timeout", () => {
    codexEnv();
    process.env.CODEX_TIMEOUT_MS = "0";
    expect(loadConfig).toThrow("CODEX_TIMEOUT_MS");
  });
});
