import { describe, expect, test } from "bun:test";
import { CodexBridge } from "./codex-bridge";

function bridge(timeoutMs = 1_000, reasoningEffort?: "max") {
  return new CodexBridge({
    maxConcurrent: 1,
    model: "gpt-5",
    workDir: process.cwd(),
    approvalPort: 7842,
    reasoningEffort,
    timeoutMs,
  });
}

describe("CodexBridge", () => {
  test("resumes a persisted Codex thread", async () => {
    const codex = bridge();
    const internal = codex as any;
    const methods: string[] = [];
    internal.ready = Promise.resolve();
    internal.send = async (method: string, params: any) => {
      methods.push(method);
      if (method === "thread/resume") return { thread: { id: params.threadId } };
      if (method === "thread/start") return { thread: { id: "new-thread" } };
      if (method === "turn/start") {
        queueMicrotask(() => {
          void internal.message({ method: "item/completed", params: { threadId: params.threadId, item: { type: "agentMessage", text: "done" } } });
          void internal.message({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: "turn-1", status: "completed", error: null } } });
        });
        return { turn: { id: "turn-1" } };
      }
    };

    const response = await codex.ask("hello", "saved-thread", false);

    expect(methods[0]).toBe("thread/resume");
    expect(response).toEqual({ text: "done", imageFiles: [], sessionId: "saved-thread" });
  });

  test("rejects a failed turn", async () => {
    const codex = bridge();
    const internal = codex as any;
    internal.ready = Promise.resolve();
    internal.threads.set("session", "thread-1");
    internal.send = async (method: string, params: any) => {
      if (method === "turn/start") {
        queueMicrotask(() => void internal.message({
          method: "turn/completed",
          params: { threadId: params.threadId, turn: { id: "turn-1", status: "failed", error: { message: "boom" } } },
        }));
        return { turn: { id: "turn-1" } };
      }
    };

    expect(codex.ask("hello", "session", false)).rejects.toThrow("boom");
  });

  test("interrupts a timed-out turn", async () => {
    const codex = bridge(5);
    const internal = codex as any;
    const methods: string[] = [];
    internal.ready = Promise.resolve();
    internal.threads.set("session", "thread-1");
    internal.send = async (method: string) => {
      methods.push(method);
      return method === "turn/start" ? { turn: { id: "turn-1" } } : {};
    };

    await expect(codex.ask("hello", "session", false)).rejects.toThrow("timed out");
    await Bun.sleep(0);

    expect(methods).toContain("turn/interrupt");
  });

  test("times out a hung thread request", async () => {
    const codex = bridge(5);
    const internal = codex as any;
    internal.ready = Promise.resolve();
    internal.write = () => {};

    await expect(codex.ask("hello", "saved-thread", false)).rejects.toThrow("thread/resume request timed out");
  });

  test("sends the configured reasoning effort", async () => {
    const codex = bridge(1_000, "max");
    const internal = codex as any;
    let turnParams: any;
    internal.ready = Promise.resolve();
    internal.threads.set("session", "thread-1");
    internal.send = async (method: string, params: any) => {
      if (method === "turn/start") {
        turnParams = params;
        queueMicrotask(() => {
          void internal.message({ method: "item/completed", params: { threadId: params.threadId, item: { type: "agentMessage", text: "done" } } });
          void internal.message({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: "turn-1", status: "completed", error: null } } });
        });
        return { turn: { id: "turn-1" } };
      }
    };

    await codex.ask("hello", "session", false);

    expect(turnParams.effort).toBe("max");
  });

  test("rejects unsupported server requests", async () => {
    const codex = bridge();
    const internal = codex as any;
    const writes: any[] = [];
    internal.write = (message: any) => writes.push(message);

    await internal.message({ id: 7, method: "item/tool/requestUserInput", params: {} });

    expect(writes).toEqual([{ id: 7, error: { code: -32601, message: "Unsupported server request: item/tool/requestUserInput" } }]);
  });

  test("decodes UTF-8 split across stdout chunks", () => {
    const internal = bridge() as any;
    const bytes = new TextEncoder().encode('{"method":"note","params":{"text":"😊"}}\n');
    const emoji = bytes.indexOf(0xf0);

    expect(internal.decode(bytes.slice(0, emoji + 2))).toEqual([]);
    expect(internal.decode(bytes.slice(emoji + 2))).toEqual([
      { method: "note", params: { text: "😊" } },
    ]);
  });
});
