import { expect, test } from "bun:test";
import type { AgentBridge } from "../core/claude-bridge";
import { parseScheduleWithAgent, setSchedulerAgentBridge } from "./scheduler";

test("schedule parsing uses the selected agent bridge", async () => {
  let prompt = "";
  const bridge: AgentBridge = {
    async ask(value) {
      prompt = value;
      return {
        text: '{"cron":"0 8 * * 1-5","prompt":"status","recurring":true,"notify":null,"directMessage":false}',
        imageFiles: [],
        sessionId: "parser-thread",
      };
    },
  };
  setSchedulerAgentBridge(bridge);

  const parsed = await parseScheduleWithAgent("weekdays at 8 status");

  expect(prompt).toContain("weekdays at 8 status");
  expect(parsed.cronExpression).toBe("0 8 * * 1-5");
});
