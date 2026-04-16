import { logger } from "../utils/logger";

interface AskOptions {
  model?: string;
  maxTurns?: number;
  timeoutMs?: number;
}

interface ClaudeResponse {
  result: string;
  is_error: boolean;
  session_id: string;
}

/** Semaphore to limit concurrent Claude processes. */
class Semaphore {
  private queue: (() => void)[] = [];
  private running = 0;

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release() {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export class ClaudeBridge {
  private semaphore: Semaphore;
  private defaultModel: string;
  private defaultMaxTurns: number;
  private workDir: string;

  constructor(opts: { maxConcurrent: number; model: string; maxTurns: number; workDir: string }) {
    this.semaphore = new Semaphore(opts.maxConcurrent);
    this.defaultModel = opts.model;
    this.defaultMaxTurns = opts.maxTurns;
    this.workDir = opts.workDir;
  }

  async ask(prompt: string, sessionId: string, isNewSession: boolean, opts?: AskOptions): Promise<string> {
    const model = opts?.model || this.defaultModel;
    const maxTurns = opts?.maxTurns || this.defaultMaxTurns;
    const timeoutMs = opts?.timeoutMs || 120_000;

    const args = [
      "--print",
      "--output-format", "text",
      "--model", model,
      "--max-turns", String(maxTurns),
    ];

    if (isNewSession) {
      args.push("--session-id", sessionId);
    } else {
      args.push("--resume", sessionId);
    }

    args.push(prompt);

    logger.debug(`Spawning claude with session ${sessionId} (new=${isNewSession})`);

    await this.semaphore.acquire();
    try {
      return await this.spawn(args, timeoutMs);
    } finally {
      this.semaphore.release();
    }
  }

  private async spawn(args: string[], timeoutMs: number): Promise<string> {
    const proc = Bun.spawn(["claude", ...args], {
      cwd: this.workDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const timeout = setTimeout(() => {
      proc.kill();
    }, timeoutMs);

    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      const exitCode = await proc.exited;
      clearTimeout(timeout);

      if (exitCode !== 0) {
        logger.error(`Claude exited with code ${exitCode}: ${stderr}`);
        throw new Error(`Claude process failed (exit ${exitCode}): ${stderr.slice(0, 200)}`);
      }

      const text = stdout.trim();
      if (!text) {
        throw new Error("Claude returned empty response");
      }

      return text;
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }
}
