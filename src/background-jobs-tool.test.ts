import { beforeEach, describe, expect, it, vi } from "vitest";
import { readCursorPluginConfig } from "./config.js";
import {
  buildBackgroundJobCustomTools,
  OPENCLAW_BACKGROUND_JOB_TOOL_NAME,
} from "./background-jobs-tool.js";
import { mergeCursorCustomTools } from "./custom-tools-merge.js";
import { resetBackgroundJobRegistryForTests } from "./background-jobs.js";

const { create, send } = vi.hoisted(() => ({
  create: vi.fn(),
  send: vi.fn(),
}));

vi.mock("@cursor/sdk", () => ({
  Agent: {
    create,
    resume: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    messages: { list: vi.fn() },
  },
}));

describe("openclaw_background_job tool", () => {
  beforeEach(() => {
    resetBackgroundJobRegistryForTests();
    create.mockReset();
    send.mockReset();
    process.env.CURSOR_API_KEY = "test-key";
  });

  it("merges without overwriting bridged tools", () => {
    const bridged = {
      message: { description: "send", async execute() { return "ok"; } },
    };
    const bg = buildBackgroundJobCustomTools({
      pluginConfig: readCursorPluginConfig({}),
      workspaceDir: "/tmp/ws",
      modelId: "composer-2.5",
      bridgeParams: { sessionId: "s1" },
    });
    const merged = mergeCursorCustomTools(bridged, bg);
    expect(merged?.message).toBe(bridged.message);
    expect(merged?.[OPENCLAW_BACKGROUND_JOB_TOOL_NAME]).toBeDefined();
  });

  it("returns disabled when background jobs are off", () => {
    const tools = buildBackgroundJobCustomTools({
      pluginConfig: readCursorPluginConfig({
        local: { backgroundJobs: { enabled: false } },
      }),
      workspaceDir: "/tmp/ws",
      modelId: "composer-2.5",
      bridgeParams: { sessionId: "s1" },
    });
    expect(tools).toBeUndefined();
  });

  it("spawn action returns jobId json", async () => {
    send.mockResolvedValue({
      id: "run-1",
      supports: () => true,
      cancel: async () => undefined,
      stream: async function* () {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "hello" }] },
        };
      },
      wait: async () => ({ id: "run-1", status: "completed" }),
    });
    create.mockResolvedValue({
      agentId: "agent-1",
      send,
      [Symbol.asyncDispose]: async () => undefined,
    });

    const tools = buildBackgroundJobCustomTools({
      pluginConfig: readCursorPluginConfig({}),
      workspaceDir: "/tmp/ws",
      modelId: "composer-2.5",
      bridgeParams: { sessionId: "s1", sessionKey: "sk1" },
    });
    const tool = tools?.[OPENCLAW_BACKGROUND_JOB_TOOL_NAME];
    expect(tool).toBeDefined();

    const raw = await tool!.execute({ action: "spawn", task: "do thing" });
    const parsed = JSON.parse(typeof raw === "string" ? raw : String(raw));
    expect(parsed.ok).toBe(true);
    expect(parsed.jobId).toBeTruthy();

    const statusRaw = await tool!.execute({ action: "status", jobId: parsed.jobId });
    const status = JSON.parse(typeof statusRaw === "string" ? statusRaw : String(statusRaw));
    expect(status.jobId).toBe(parsed.jobId);
  });
});
