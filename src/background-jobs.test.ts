import { beforeEach, describe, expect, it, vi } from "vitest";
import { readCursorPluginConfig } from "./config.js";
import {
  BackgroundJobConcurrencyError,
  getBackgroundJobRegistry,
  resetBackgroundJobRegistryForTests,
} from "./background-jobs.js";
import { resetBackgroundJobWorkflowForTests } from "./background-jobs-workflow.js";

const { create, send, deliverBackgroundJobCompletion } = vi.hoisted(() => ({
  create: vi.fn(),
  send: vi.fn(),
  deliverBackgroundJobCompletion: vi.fn(async () => undefined),
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

vi.mock("./background-jobs-deliver.js", () => ({
  deliverBackgroundJobCompletion,
}));

function pluginConfig() {
  return readCursorPluginConfig({
    local: { backgroundJobs: { enabled: true, maxConcurrent: 1, persistJobs: false } },
  });
}

function createBlockingRun() {
  let releaseStream!: () => void;
  const streamGate = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  const run = {
    id: "run-1",
    supports: (op: string) => op === "cancel" || op === "stream" || op === "wait",
    cancel: vi.fn(async () => {
      releaseStream();
    }),
    stream: async function* () {
      await streamGate;
    },
    wait: vi.fn(async () => ({ id: "run-1", status: "cancelled" })),
  };
  return { run, releaseStream: () => releaseStream() };
}

describe("background jobs registry", () => {
  beforeEach(() => {
    resetBackgroundJobRegistryForTests();
    resetBackgroundJobWorkflowForTests();
    create.mockReset();
    send.mockReset();
    process.env.CURSOR_API_KEY = "test-key";
  });

  it("spawns a job and completes with assistant snippet", async () => {
    send.mockResolvedValue({
      id: "run-1",
      supports: (op: string) => op === "cancel" || op === "stream" || op === "wait",
      cancel: vi.fn(async () => undefined),
      stream: async function* () {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "done work" }] },
        };
      },
      wait: vi.fn(async () => ({ id: "run-1", status: "completed" })),
    });
    create.mockResolvedValue({
      agentId: "agent-bg-1",
      send,
      [Symbol.asyncDispose]: async () => undefined,
    });

    const registry = getBackgroundJobRegistry(pluginConfig());
    const job = await registry.spawn({
      pluginConfig: pluginConfig(),
      task: "refactor module",
      modelId: "composer-2.5",
      workspaceDir: "/tmp/ws",
      sessionKey: "sess-1",
    });

    expect(job.status).toBe("queued");
    expect(job.id).toBeTruthy();
    await vi.waitFor(() => {
      const latest = registry.getJobPublic(job.id);
      expect(latest?.status).toBe("succeeded");
      expect(latest?.lastAssistantSnippet).toContain("done work");
    });
  });

  it("rejects spawn when maxConcurrent is reached", async () => {
    const { run, releaseStream } = createBlockingRun();
    send.mockResolvedValue(run);
    create.mockResolvedValue({
      agentId: "agent-bg-1",
      send,
      [Symbol.asyncDispose]: async () => undefined,
    });

    const registry = getBackgroundJobRegistry(pluginConfig());
    await registry.spawn({
      pluginConfig: pluginConfig(),
      task: "first",
      modelId: "composer-2.5",
      workspaceDir: "/tmp/ws",
    });

    await vi.waitFor(() => {
      expect(registry.getJobPublic(registry.listJobs()[0]!.id)?.status).toBe("running");
    });

    await expect(
      registry.spawn({
        pluginConfig: pluginConfig(),
        task: "second",
        modelId: "composer-2.5",
        workspaceDir: "/tmp/ws",
      }),
    ).rejects.toBeInstanceOf(BackgroundJobConcurrencyError);

    releaseStream();
  });

  it("delivers completion notice after job succeeds", async () => {
    deliverBackgroundJobCompletion.mockClear();

    send.mockResolvedValue({
      id: "run-1",
      supports: (op: string) => op === "cancel" || op === "stream" || op === "wait",
      cancel: vi.fn(async () => undefined),
      stream: async function* () {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "all done" }] },
        };
      },
      wait: vi.fn(async () => ({ id: "run-1", status: "completed" })),
    });
    create.mockResolvedValue({
      agentId: "agent-bg-1",
      send,
      [Symbol.asyncDispose]: async () => undefined,
    });

    const registry = getBackgroundJobRegistry(pluginConfig());
    const job = await registry.spawn({
      pluginConfig: pluginConfig(),
      task: "work",
      modelId: "composer-2.5",
      workspaceDir: "/tmp/ws",
      sessionKey: "agent:main:webchat",
      notifyContext: { sessionId: "sess-1", sessionKey: "agent:main:webchat" },
    });

    await vi.waitFor(() => {
      expect(registry.getJobPublic(job.id)?.status).toBe("succeeded");
    });
    expect(deliverBackgroundJobCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:webchat",
        jobId: job.id,
      }),
    );
  });

  it("cancels a running job", async () => {
    const { run, releaseStream } = createBlockingRun();
    send.mockResolvedValue(run);
    create.mockResolvedValue({
      agentId: "agent-bg-1",
      send,
      [Symbol.asyncDispose]: async () => undefined,
    });

    const registry = getBackgroundJobRegistry(pluginConfig());
    const job = await registry.spawn({
      pluginConfig: pluginConfig(),
      task: "slow",
      modelId: "composer-2.5",
      workspaceDir: "/tmp/ws",
    });

    await vi.waitFor(() => {
      expect(registry.getJobPublic(job.id)?.status).toBe("running");
    });

    const cancelled = await registry.cancel(job.id);
    expect(cancelled.status).toBe("cancelled");
    releaseStream();
  });
});
