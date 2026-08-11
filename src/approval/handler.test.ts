import { describe, expect, test } from "bun:test";
import { formatToolInput } from "./handler";

describe("formatToolInput", () => {
  test("shows Codex file-change approval context", () => {
    const text = formatToolInput("Edit", {
      reason: "Update configuration",
      grantRoot: "/workspace",
      changes: [{ path: "/workspace/app.ts", kind: "update", diff: "+safe" }],
    });

    expect(text).toContain("Update configuration");
    expect(text).toContain("/workspace");
    expect(text).toContain("/workspace/app.ts");
  });

  test("shows Codex command approval context", () => {
    const text = formatToolInput("Bash", {
      command: "curl https://example.com",
      cwd: "/workspace",
      reason: "Network access",
      networkApprovalContext: { host: "example.com", protocol: "https" },
    });

    expect(text).toContain("Network access");
    expect(text).toContain("example.com");
    expect(text).toContain("/workspace");
  });
});
