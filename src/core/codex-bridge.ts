import { logger } from "../utils/logger";
import type { CodexReasoningEffort } from "../config";
import type { AgentBridge, AskOptions, Attachment, BridgeResponse } from "./claude-bridge";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type CodexProcess = Bun.Subprocess<"pipe", "pipe", "inherit">;
type RpcId = number | string;
type RpcParams = {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  delta?: string;
  reason?: string;
  command?: string;
  cwd?: string;
  grantRoot?: string;
  networkApprovalContext?: unknown;
  commandActions?: unknown;
  proposedExecpolicyAmendment?: unknown;
  item?: { id?: string; type?: string; text?: string; changes?: unknown };
  turn?: { id?: string; status?: string; error?: { message?: unknown } | null };
  [key: string]: unknown;
};
type RpcMessage = { id?: RpcId; method?: string; params?: RpcParams; result?: unknown; error?: unknown };
type ThreadResult = { thread?: { id?: string } };
type TurnStartResult = { turn?: { id?: string } };
type TurnState = {
  delta?: (delta: string) => void;
  text: string;
  turnId?: string;
  timedOut?: boolean;
  resolve?: () => void;
  reject?: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

class Semaphore {
  private running = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(() => {
      this.running++;
      resolve();
    }));
  }

  release(): void {
    this.running--;
    this.queue.shift()?.();
  }
}

function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") {
    return new Error(value.message);
  }
  return new Error(JSON.stringify(value) || String(value));
}

/** Codex App Server JSON-RPC client. Protocol verified with `codex app-server generate-ts`. */
export class CodexBridge implements AgentBridge {
  private process?: CodexProcess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private threads = new Map<string, string>();
  private turns = new Map<string, TurnState>();
  private fileChanges = new Map<string, unknown>();
  private buffer = "";
  private decoder = new TextDecoder();
  private ready?: Promise<void>;
  private readonly limiter: Semaphore;

  constructor(private readonly opts: {
    maxConcurrent: number;
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
    workDir: string;
    codexCodePath?: string;
    approvalPort: number;
    approvalPolicy?: "untrusted" | "on-request" | "never";
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    timeoutMs: number;
  }) {
    this.limiter = new Semaphore(opts.maxConcurrent);
  }

  private write(message: unknown): void {
    if (!this.process) throw new Error("Codex app-server is not running");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private send<T>(method: string, params: unknown, timed = true): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timed ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} request timed out`));
      }, this.opts.timeoutMs) : undefined;
      const clear = () => {
        if (timer) clearTimeout(timer);
      };
      this.pending.set(id, {
        resolve: (value) => {
          clear();
          resolve(value as T);
        },
        reject: (error) => {
          clear();
          reject(error);
        },
      });
      try {
        this.write({ method, id, params });
      } catch (error) {
        this.pending.delete(id);
        clear();
        reject(asError(error));
      }
    });
  }

  private fail(error: Error, source?: CodexProcess): void {
    if (source && source !== this.process) return;
    const process = this.process;
    this.process = undefined;
    this.ready = undefined;
    this.buffer = "";
    this.decoder = new TextDecoder();
    this.threads.clear();
    this.fileChanges.clear();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const turn of this.turns.values()) {
      if (turn.timer) clearTimeout(turn.timer);
      turn.reject?.(error);
    }
    this.turns.clear();
    try {
      process?.kill();
    } catch {}
  }

  private decode(chunk?: Uint8Array): RpcMessage[] {
    this.buffer += chunk !== undefined ? this.decoder.decode(chunk, { stream: true }) : this.decoder.decode();
    const messages: RpcMessage[] = [];
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) messages.push(JSON.parse(line) as RpcMessage);
    }
    if (chunk === undefined && this.buffer.trim()) {
      messages.push(JSON.parse(this.buffer) as RpcMessage);
      this.buffer = "";
    }
    return messages;
  }

  private async start(): Promise<void> {
    const process = Bun.spawn([this.opts.codexCodePath || "codex", "app-server", "--stdio"], {
      cwd: this.opts.workDir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    this.process = process;
    this.buffer = "";
    this.decoder = new TextDecoder();
    const reader = process.stdout.getReader();
    void (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const message of this.decode(value)) void this.message(message, process);
      }
      for (const message of this.decode()) void this.message(message, process);
      this.fail(new Error("Codex app-server exited"), process);
    })().catch((error) => {
      logger.error("Codex app-server reader failed:", error);
      this.fail(asError(error), process);
    });
    await this.send("initialize", {
      clientInfo: { name: "channels-listener", title: "channels-listener", version: "0.1.0" },
    });
    this.write({ method: "initialized", params: {} });
  }

  private async message(message: RpcMessage, source?: CodexProcess): Promise<void> {
    if (source && source !== this.process) return;
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const id = typeof message.id === "number" ? message.id : Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if ("error" in message && message.error !== undefined) pending.reject(asError(message.error));
      else pending.resolve(message.result);
      return;
    }

    if (message.id === undefined) {
      const params = message.params;
      const threadId = params?.threadId;
      const turn = threadId ? this.turns.get(threadId) : undefined;
      if (message.method === "item/started" && params?.item?.type === "fileChange" && params.item.id) {
        this.fileChanges.set(params.item.id, params.item.changes);
      }
      if (message.method === "item/agentMessage/delta" && typeof params?.delta === "string") {
        turn?.delta?.(params.delta);
      }
      if (message.method === "item/completed" && params?.item?.type === "agentMessage" && turn && typeof params.item.text === "string") {
        turn.text = params.item.text;
      }
      if (message.method === "item/completed" && params?.item?.id) this.fileChanges.delete(params.item.id);
      if (message.method === "turn/completed" && turn) {
        if (params?.turn?.status === "completed") turn.resolve?.();
        else turn.reject?.(new Error(
          typeof params?.turn?.error?.message === "string"
            ? params.turn.error.message
            : `Codex turn ${params?.turn?.status || "failed"}`,
        ));
      }
      return;
    }

    if (message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval") {
      await this.handleApproval(message, source);
      return;
    }
    this.write({
      id: message.id,
      error: { code: -32601, message: `Unsupported server request: ${message.method || "unknown"}` },
    });
  }

  private async handleApproval(message: RpcMessage, source?: CodexProcess): Promise<void> {
    const params = message.params || {};
    const command = message.method === "item/commandExecution/requestApproval";
    const toolInput = command
      ? {
          command: params.command || "",
          cwd: params.cwd || "",
          reason: params.reason,
          networkApprovalContext: params.networkApprovalContext,
          commandActions: params.commandActions,
          proposedExecpolicyAmendment: params.proposedExecpolicyAmendment,
        }
      : {
          reason: params.reason,
          grantRoot: params.grantRoot,
          changes: params.itemId ? this.fileChanges.get(params.itemId) : undefined,
        };
    let decision = "decline";
    try {
      const sessionId = [...this.threads.entries()].find(([, id]) => id === params.threadId)?.[0] || params.threadId;
      const response = await fetch(`http://127.0.0.1:${this.opts.approvalPort}/approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          tool_name: command ? "Bash" : "Edit",
          tool_input: toolInput,
          hook_event_name: message.method,
        }),
      });
      const body = await response.json() as { decision?: unknown };
      if (response.ok && body.decision === "allow") decision = "accept";
    } catch (error) {
      logger.warn("Codex approval failed; declining:", error);
    }
    if (source && source !== this.process) return;
    try {
      this.write({ id: message.id, result: { decision } });
    } catch {}
  }

  async ask(
    prompt: string,
    sessionId: string,
    isNewSession: boolean,
    attachments?: Attachment[],
    opts?: AskOptions,
  ): Promise<BridgeResponse> {
    await this.limiter.acquire();
    try {
      return await this.runAsk(prompt, sessionId, isNewSession, attachments, opts);
    } finally {
      this.limiter.release();
    }
  }

  private async runAsk(
    prompt: string,
    sessionId: string,
    isNewSession: boolean,
    attachments?: Attachment[],
    opts?: AskOptions,
  ): Promise<BridgeResponse> {
    if (!this.ready) this.ready = this.start().catch((error) => {
      this.ready = undefined;
      throw error;
    });
    await this.ready;

    const model = opts?.model || this.opts.model;
    const threadOptions = {
      cwd: this.opts.workDir,
      ...(model ? { model } : {}),
      ...(this.opts.approvalPolicy ? { approvalPolicy: this.opts.approvalPolicy } : {}),
      ...(this.opts.sandbox ? { sandbox: this.opts.sandbox } : {}),
    };
    let threadId = isNewSession ? undefined : this.threads.get(sessionId);
    if (!threadId) {
      const result = isNewSession
        ? await this.send<ThreadResult>("thread/start", threadOptions)
        : await this.send<ThreadResult>("thread/resume", { threadId: sessionId, ...threadOptions });
      threadId = result.thread?.id;
      if (!threadId) throw new Error("Codex app-server returned no thread ID");
      this.threads.set(sessionId, threadId);
    }

    const input: Array<Record<string, unknown>> = [{ type: "text", text: prompt, text_elements: [] }];
    for (const attachment of attachments || []) {
      input.push({ type: "image", url: `data:${attachment.mediaType};base64,${attachment.data}` });
    }
    const turn: TurnState = { delta: opts?.onTextDelta, text: "" };
    this.turns.set(threadId, turn);
    const completion = new Promise<void>((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
    });
    const timeout = new Promise<never>((_, reject) => {
      turn.timer = setTimeout(() => {
        turn.timedOut = true;
        if (turn.turnId) void this.send("turn/interrupt", { threadId, turnId: turn.turnId }).catch(() => {});
        reject(new Error("Codex turn timed out"));
      }, this.opts.timeoutMs);
    });

    try {
      const start = this.send<TurnStartResult>("turn/start", {
        threadId,
        input,
        ...(model ? { model } : {}),
        ...(this.opts.reasoningEffort ? { effort: this.opts.reasoningEffort } : {}),
      }, false);
      void start.then((result) => {
        turn.turnId = result.turn?.id;
        if (turn.timedOut && turn.turnId) {
          void this.send("turn/interrupt", { threadId, turnId: turn.turnId }).catch(() => {});
        }
      }).catch(() => {});
      const result = await Promise.race([start, timeout]);
      turn.turnId = result.turn?.id;
      if (!turn.turnId) throw new Error("Codex app-server returned no turn ID");
      await Promise.race([completion, timeout]);
      if (!turn.text) throw new Error("Codex returned empty response");
      await opts?.onStreamEnd?.();
      return { text: turn.text, imageFiles: [], sessionId: threadId };
    } finally {
      if (turn.timer) clearTimeout(turn.timer);
      this.turns.delete(threadId);
    }
  }

  destroy(): void {
    this.fail(new Error("Codex app-server stopped"));
  }
}
