import { beforeEach, describe, expect, it, vi } from "vitest";

const { prompt, listMessages } = vi.hoisted(() => ({
  prompt: vi.fn(),
  listMessages: vi.fn(),
}));

vi.mock("@cursor/sdk", () => ({
  Agent: {
    prompt,
    messages: { list: listMessages },
  },
}));

import { maybeCompactCursorSession } from "./compact.js";
import { runCursorSideQuestion } from "./side-question.js";
import type { CursorBindingStore, StoredCursorBinding } from "./session-binding.js";

function memoryStore(seed?: Record<string, StoredCursorBinding>): CursorBindingStore {
  const map = new Map<string, StoredCursorBinding>(Object.entries(seed ?? {}));
  return {
    lookup: (key) => map.get(key),
    register: (key, value) => {
      map.set(key, value);
    },
    delete: (key) => {
      map.delete(key);
    },
  };
}

describe("runCursorSideQuestion", () => {
  beforeEach(() => {
    prompt.mockReset();
    listMessages.mockReset();
    process.env.CURSOR_API_KEY = "test-key";
  });

  it("answers via isolated Agent.prompt without touching bindings", async () => {
    prompt.mockResolvedValue({ id: "run-1", status: "finished", result: "42" });
    const result = await runCursorSideQuestion(
      {
        question: "what is 6*7?",
        workspaceDir: "/tmp/ws",
        model: "composer-2.5",
      },
      { pluginConfig: { local: { autoReview: true } } },
    );
    expect(result).toEqual({ text: "42" });
    expect(prompt).toHaveBeenCalledOnce();
    const [, options] = prompt.mock.calls[0]!;
    expect(options.local.autoReview).toBe(true);
    expect(options.local.cwd).toBe("/tmp/ws");
  });
});

describe("maybeCompactCursorSession", () => {
  beforeEach(() => {
    prompt.mockReset();
    listMessages.mockReset();
    process.env.CURSOR_API_KEY = "test-key";
  });

  it("returns missing_thread_binding when unbound", async () => {
    const result = await maybeCompactCursorSession(
      { sessionId: "sess-1" },
      { bindingStore: memoryStore() },
    );
    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      reason: "missing_thread_binding",
    });
  });

  it("summarizes bound agent transcript", async () => {
    listMessages.mockResolvedValue([
      { type: "user_message", message: "ship the plugin" },
      { type: "assistant_message", message: "working on compact" },
    ]);
    prompt.mockResolvedValue({
      id: "run-2",
      status: "finished",
      result: "User asked to ship plugin; compact work in progress.",
    });

    const store = memoryStore({
      "sess-1": {
        schemaVersion: 1,
        agentId: "bc-agent-1",
        compatKey: "provider=cursor|model=composer-2.5",
        runtime: "local",
        updatedAt: 1,
      },
    });

    const result = await maybeCompactCursorSession(
      {
        sessionId: "sess-1",
        sessionFile: "/tmp/sess.jsonl",
        workspaceDir: "/tmp/ws",
        model: "composer-2.5",
        currentTokenCount: 1200,
      },
      { bindingStore: store },
    );

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.summary).toContain("ship plugin");
    expect(listMessages).toHaveBeenCalledWith(
      "bc-agent-1",
      expect.objectContaining({ cwd: "/tmp/ws", limit: 80 }),
    );
  });

  it("clears stale bindings on not-found errors", async () => {
    listMessages.mockRejectedValue(new Error("unknown agent not found"));
    const store = memoryStore({
      "sess-1": {
        schemaVersion: 1,
        agentId: "gone",
        compatKey: "k",
        runtime: "local",
        updatedAt: 1,
      },
    });
    const result = await maybeCompactCursorSession(
      { sessionId: "sess-1", workspaceDir: "/tmp/ws" },
      { bindingStore: store },
    );
    expect(result.reason).toBe("stale_thread_binding");
    expect(store.lookup("sess-1")).toBeUndefined();
  });
});
