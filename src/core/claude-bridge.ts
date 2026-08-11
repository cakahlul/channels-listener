import { query } from "@anthropic-ai/claude-agent-sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources";
import { logger } from "../utils/logger";

export interface Attachment {
  /** Base64-encoded image data */
  data: string;
  /** MIME type: image/png, image/jpeg, image/gif, image/webp */
  mediaType: string;
}

export interface BridgeResponse {
  text: string;
  /** Absolute paths to image files the agent created during this turn */
  imageFiles: string[];
  /** Provider session/thread ID to persist for the next message. */
  sessionId: string;
}

export interface AskOptions {
  model?: string;
  maxTurns?: number;
  /** Called with each text delta during streaming. */
  onTextDelta?: (delta: string) => void;
  /** Called when the stream is complete (before image extraction). */
  onStreamEnd?: () => Promise<void>;
}

export interface AgentBridge {
  ask(
    prompt: string,
    sessionId: string,
    isNewSession: boolean,
    attachments?: Attachment[],
    opts?: AskOptions,
  ): Promise<BridgeResponse>;
  destroy?(): void;
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

/** Regex to find image file paths in Claude's response text. */
const IMAGE_PATH_RE = /(?:^|\s)(\/[^\s]+\.(?:png|jpg|jpeg|gif|webp|svg))(?:\s|$|[)\].,])/gim;

export class ClaudeBridge implements AgentBridge {
  private semaphore: Semaphore;
  private defaultModel: string;
  private defaultMaxTurns: number;
  private workDir: string;
  private claudeCodePath?: string;

  constructor(opts: { maxConcurrent: number; model: string; maxTurns: number; workDir: string; claudeCodePath?: string }) {
    this.semaphore = new Semaphore(opts.maxConcurrent);
    this.defaultModel = opts.model;
    this.defaultMaxTurns = opts.maxTurns;
    this.workDir = opts.workDir;
    this.claudeCodePath = opts.claudeCodePath;
  }

  async ask(
    prompt: string,
    sessionId: string,
    isNewSession: boolean,
    attachments?: Attachment[],
    opts?: AskOptions,
  ): Promise<BridgeResponse> {
    const model = opts?.model || this.defaultModel;
    const maxTurns = opts?.maxTurns || this.defaultMaxTurns;
    const onTextDelta = opts?.onTextDelta;
    const onStreamEnd = opts?.onStreamEnd;

    // Build the message content blocks
    const content: MessageParam["content"] = [];

    // Add images first
    if (attachments?.length) {
      for (const att of attachments) {
        content.push({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: att.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
            data: att.data,
          },
        });
      }
    }

    // Add text prompt
    content.push({ type: "text" as const, text: prompt });

    logger.debug(`Querying claude SDK session=${sessionId} (new=${isNewSession}) images=${attachments?.length ?? 0} streaming=${!!onTextDelta}`);

    await this.semaphore.acquire();
    try {
      const sdkPrompt: MessageParam = { role: "user", content };

      const options: Parameters<typeof query>[0]["options"] = {
        model,
        maxTurns,
        cwd: this.workDir,
        permissionMode: "default",
        ...(this.claudeCodePath ? { pathToClaudeCodeExecutable: this.claudeCodePath } : {}),
        ...(isNewSession
          ? { sessionId }
          : { resume: sessionId }),
        // Enable partial message streaming when a delta handler is provided
        ...(onTextDelta ? { includePartialMessages: true } : {}),
      };

      let resultText = "";
      let finalSessionId = sessionId;

      for await (const message of query({
        prompt: (async function* () {
          yield {
            type: "user" as const,
            message: sdkPrompt,
            parent_tool_use_id: null,
          };
        })(),
        options,
      })) {
        // Stream text deltas to the caller
        if (onTextDelta && message.type === "stream_event") {
          const event = (message as any).event;
          if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
            onTextDelta(event.delta.text);
          }
        }

        if (message.type === "result") {
          finalSessionId = message.session_id;
          if (message.subtype === "success") {
            resultText = message.result ?? "";
          } else {
            const errors = "errors" in message ? message.errors : [];
            resultText = errors?.join("\n") || "Claude encountered an error.";
          }
        }
      }

      // Signal stream end so the channel can flush any buffered content
      if (onStreamEnd) {
        await onStreamEnd();
      }

      if (!resultText) {
        throw new Error("Claude returned empty response");
      }

      // Extract image file paths from response
      const imageFiles: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = IMAGE_PATH_RE.exec(resultText)) !== null) {
        const filePath = match[1]!;
        // Verify file actually exists before including
        try {
          const file = Bun.file(filePath);
          if (await file.exists()) {
            imageFiles.push(filePath);
          }
        } catch {}
      }

      return { text: resultText, imageFiles, sessionId: finalSessionId };
    } finally {
      this.semaphore.release();
    }
  }
}
