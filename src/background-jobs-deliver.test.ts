import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureBackgroundJobWorkflow, resetBackgroundJobWorkflowForTests } from "./background-jobs-workflow.js";
import { deliverBackgroundJobCompletion } from "./background-jobs-deliver.js";

vi.mock("openclaw/plugin-sdk/agent-harness", () => ({
  createOpenClawCodingTools: vi.fn(async () => [
    {
      name: "sessions_send",
      async execute() {
        return { ok: true };
      },
    },
  ]),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  isMessagingTool: (name: string) => name === "message",
}));

describe("deliverBackgroundJobCompletion", () => {
  beforeEach(() => {
    resetBackgroundJobWorkflowForTests();
  });

  it("uses sessions_send when sessionKey is available", async () => {
    const scheduleSessionTurn = vi.fn(async () => ({}));
    configureBackgroundJobWorkflow({ scheduleSessionTurn });

    await deliverBackgroundJobCompletion({
      jobId: "job-1",
      text: "done",
      sessionKey: "agent:main:telegram:123",
      notifyContext: {
        sessionId: "sess-1",
        sessionKey: "agent:main:telegram:123",
        messageTo: "123",
        messageChannel: "telegram",
      },
    });

    expect(scheduleSessionTurn).not.toHaveBeenCalled();
  });

  it("falls back to scheduleSessionTurn when tools are unavailable", async () => {
    const { createOpenClawCodingTools } = await import("openclaw/plugin-sdk/agent-harness");
    vi.mocked(createOpenClawCodingTools).mockResolvedValueOnce([]);

    const scheduleSessionTurn = vi.fn(async () => ({}));
    configureBackgroundJobWorkflow({ scheduleSessionTurn });

    await deliverBackgroundJobCompletion({
      jobId: "job-2",
      text: "done",
      sessionKey: "agent:main:webchat",
      notifyContext: { sessionId: "sess-2", sessionKey: "agent:main:webchat" },
    });

    expect(scheduleSessionTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:webchat",
        deliveryMode: "announce",
      }),
    );
  });
});
