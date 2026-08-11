import { logger } from "../utils/logger";
import type { Attachment, BridgeResponse } from "./claude-bridge";
import { ClaudeBridge } from "./claude-bridge";

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };
class Semaphore {
  private running = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  acquire(): Promise<void> {
    if (this.running < this.max) { this.running++; return Promise.resolve(); }
    return new Promise((resolve) => this.queue.push(() => { this.running++; resolve(); }));
  }
  release() { this.running--; this.queue.shift()?.(); }
}
type TurnState = { delta?: (delta: string) => void; text: string; resolve?: () => void; reject?: (error: Error) => void; timer?: ReturnType<typeof setTimeout> };

/** Codex App Server JSON-RPC client. Protocol verified with `codex app-server generate-ts`. */
export class CodexBridge extends ClaudeBridge {
  private process?: ReturnType<typeof Bun.spawn>;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private threads = new Map<string, string>();
  private buffer = "";
  private ready?: Promise<void>;
  private readonly semaphore: Semaphore;
  private turns = new Map<string, TurnState>();
  private readonly codexPath: string;
  private readonly model: string;
  private readonly workDir: string;
  private readonly approvalPort: number;
  private readonly approvalPolicy?: "untrusted" | "on-request" | "never";
  private readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  private readonly timeoutMs: number;

  constructor(opts: { maxConcurrent: number; model: string; maxTurns: number; workDir: string; codexCodePath?: string; approvalPort: number; approvalPolicy?: "untrusted" | "on-request" | "never"; sandbox?: "read-only" | "workspace-write" | "danger-full-access"; timeoutMs: number }) {
    super({ maxConcurrent: opts.maxConcurrent, model: opts.model, maxTurns: opts.maxTurns, workDir: opts.workDir });
    this.codexPath = opts.codexCodePath || "codex";
    this.model = opts.model;
    this.workDir = opts.workDir;
    this.approvalPort = opts.approvalPort;
    this.approvalPolicy = opts.approvalPolicy;
    this.sandbox = opts.sandbox;
    this.timeoutMs = opts.timeoutMs;
    this.semaphore = new Semaphore(opts.maxConcurrent);
  }

  private send(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    const promise = new Promise<any>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.process!.stdin.write(JSON.stringify({ method, id, params }) + "\n");
    return promise;
  }

  private fail(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const turn of this.turns.values()) {
      if (turn.timer) clearTimeout(turn.timer);
      turn.reject?.(error);
    }
    this.turns.clear();
    this.process = undefined;
    this.ready = undefined;
  }

  private async start() {
    this.process = Bun.spawn([this.codexPath, "app-server", "--stdio"], { cwd: this.workDir, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = this.process.stdout.getReader();
    void (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        this.buffer += new TextDecoder().decode(value);
        let newline;
        while ((newline = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1);
          if (line) void this.message(JSON.parse(line));
        }
      }
      this.fail(new Error("Codex app-server exited"));
    })().catch((error) => {
      logger.error("Codex app-server reader failed:", error);
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
    await this.send("initialize", { clientInfo: { name: "channels-listener", title: "channels-listener", version: "0.1.0" }, capabilities: null });
    this.process.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  }

  private async message(message: any) {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(Number(message.id)); if (!pending) return;
      this.pending.delete(Number(message.id));
      message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
      return;
    }
    if (message.id === undefined) {
      const threadId = message.params?.threadId;
      const turn = threadId ? this.turns.get(threadId) : undefined;
      if (message.method === "item/agentMessage/delta") turn?.delta?.(message.params.delta || "");
      if (message.method === "item/completed" && message.params.item?.type === "agentMessage" && turn) turn.text = message.params.item.text;
      if (message.method === "turn/completed") turn?.resolve?.();
    }
    if (message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval") {
        const p = message.params; const toolName = message.method.includes("command") ? "Bash" : "Edit";
        const input = toolName === "Bash" ? { command: p.command || "", cwd: p.cwd || "" } : { reason: p.reason || "", grantRoot: p.grantRoot || "" };
        try {
          const response = await fetch(`http://127.0.0.1:${this.approvalPort}/approval`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: [...this.threads.entries()].find(([, id]) => id === p.threadId)?.[0] || p.threadId, tool_name: toolName, tool_input: input, hook_event_name: message.method }) });
          const decision = await response.json();
          this.process!.stdin.write(JSON.stringify({ id: message.id, result: { decision: decision.decision === "allow" ? "accept" : "decline" } }) + "\n");
        } catch { this.process!.stdin.write(JSON.stringify({ id: message.id, result: { decision: "decline" } }) + "\n"); }
    }
  }

  override async ask(prompt: string, sessionId: string, isNewSession: boolean, attachments?: Attachment[], opts?: { onTextDelta?: (delta: string) => void; onStreamEnd?: () => Promise<void> }): Promise<BridgeResponse> {
    await this.semaphore.acquire();
    try {
      return await this.runAsk(prompt, sessionId, isNewSession, attachments, opts);
    } finally {
      this.semaphore.release();
    }
  }

  private async runAsk(prompt: string, sessionId: string, isNewSession: boolean, attachments?: Attachment[], opts?: { onTextDelta?: (delta: string) => void; onStreamEnd?: () => Promise<void> }): Promise<BridgeResponse> {
    if (!this.ready) this.ready = this.start().catch((error) => { this.ready = undefined; throw error; });
    await this.ready;
    let threadId = this.threads.get(sessionId);
    if (!threadId || isNewSession) {
      const result = await this.send("thread/start", { model: this.model, cwd: this.workDir, ...(this.approvalPolicy ? { approvalPolicy: this.approvalPolicy } : {}), ...(this.sandbox ? { sandbox: this.sandbox } : {}) });
      threadId = result.thread.id; this.threads.set(sessionId, threadId);
    }
    const input: any[] = [{ type: "text", text: prompt, text_elements: [] }];
    for (const attachment of attachments || []) input.push({ type: "image", url: `data:${attachment.mediaType};base64,${attachment.data}` });
    const turn: TurnState = { delta: opts?.onTextDelta, text: "" };
    this.turns.set(threadId, turn);
    const completion = new Promise<void>((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
      turn.timer = setTimeout(() => reject(new Error("Codex turn timed out")), this.timeoutMs);
    });
    try {
      await this.send("turn/start", { threadId, input, model: this.model });
      await completion;
      await opts?.onStreamEnd?.();
      return { text: turn.text, imageFiles: [] };
    } finally {
      if (turn.timer) clearTimeout(turn.timer);
      this.turns.delete(threadId);
    }
  }
}
