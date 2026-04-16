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
  /** Absolute paths to image files Claude created during this turn */
  imageFiles: string[];
}

interface AskOptions {
  model?: string;
  maxTurns?: number;
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

  async ask(
    prompt: string,
    sessionId: string,
    isNewSession: boolean,
    attachments?: Attachment[],
    opts?: AskOptions,
  ): Promise<BridgeResponse> {
    const model = opts?.model || this.defaultModel;
    const maxTurns = opts?.maxTurns || this.defaultMaxTurns;

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

    logger.debug(`Querying claude SDK session=${sessionId} (new=${isNewSession}) images=${attachments?.length ?? 0}`);

    await this.semaphore.acquire();
    try {
      const sdkPrompt: MessageParam = { role: "user", content };

      const options: Parameters<typeof query>[0]["options"] = {
        model,
        maxTurns,
        cwd: this.workDir,
        permissionMode: "default",
        ...(isNewSession
          ? { sessionId }
          : { resume: sessionId }),
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

      return { text: resultText, imageFiles };
    } finally {
      this.semaphore.release();
    }
  }
}
