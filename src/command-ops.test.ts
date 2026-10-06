import { beforeEach, describe, expect, it, vi } from "vitest";

const { list, get, resume, messagesList, modelsList, me, listRuns } = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  resume: vi.fn(),
  messagesList: vi.fn(),
  modelsList: vi.fn(),
  me: vi.fn(),
  listRuns: vi.fn(),
}));

vi.mock("@cursor/sdk", () => ({
  Agent: {
    list,
    get,
    resume,
    listRuns,
    messages: { list: messagesList },
  },
  Cursor: {
    models: { list: modelsList },
    me,
  },
}));

import {
  buildCursorDiagnostics,
  describeCursorAgent,
  listCursorAgentRuns,
  listCursorAgents,
  listCursorModels,
  listProjectedMcpServers,
  resumeCursorAgentToSession,
} from "./command-ops.js";

describe("command ops", () => {
  beforeEach(() => {
    list.mockReset();
    get.mockReset();
    resume.mockReset();
    messagesList.mockReset();
    modelsList.mockReset();
    me.mockReset();
    process.env.CURSOR_API_KEY = "test-key";
  });

  it("lists agents", async () => {
    list.mockResolvedValue({
      items: [
        {
          agentId: "agent-1",
          name: "Fix plugin",
          summary: "working",
          status: "finished",
        },
      ],
    });
    const text = await listCursorAgents({ pluginConfig: { runtime: "local" } });
    expect(text).toContain("agent-1");
    expect(list).toHaveBeenCalledOnce();
  });

  it("describes an agent with messages", async () => {
    get.mockResolvedValue({
      agentId: "agent-1",
      name: "Fix plugin",
      status: "finished",
      summary: "done",
    });
    messagesList.mockResolvedValue([
      { type: "user", message: "hello" },
      { type: "assistant", message: "hi" },
    ]);
    const text = await describeCursorAgent({
      agentId: "agent-1",
      pluginConfig: { runtime: "local" },
    });
    expect(text).toContain("Fix plugin");
    expect(text).toContain("hello");
  });

  it("resumes agent into session binding store", async () => {
    get.mockResolvedValue({
      agentId: "agent-9",
      name: "Existing",
      status: "finished",
    });
    const store = {
      map: new Map(),
      lookup(key: string) {
        return this.map.get(key);
      },
      register(key: string, value: unknown) {
        this.map.set(key, value);
      },
      delete(key: string) {
        this.map.delete(key);
      },
    };
    const text = await resumeCursorAgentToSession({
      cursorAgentId: "agent-9",
      ctx: { sessionId: "sess-1", sessionKey: "agent:main:chat", agentId: "main" },
      bindingStore: store,
      pluginConfig: { runtime: "local" },
    });
    expect(text).toContain("agent-9");
    expect(store.map.size).toBeGreaterThan(0);
  });

  it("lists models", async () => {
    modelsList.mockResolvedValue([{ id: "composer-2.5", displayName: "Composer 2.5" }]);
    const text = await listCursorModels({ pluginConfig: { runtime: "local" } });
    expect(text).toContain("composer-2.5");
  });

  it("lists runs for an agent", async () => {
    listRuns.mockResolvedValue({
      items: [{ id: "run-1", agentId: "agent-1", status: "finished", durationMs: 1200 }],
    });
    const text = await listCursorAgentRuns({
      agentId: "agent-1",
      pluginConfig: { runtime: "local" },
    });
    expect(text).toContain("run-1");
  });

  it("lists projected mcp servers", () => {
    const text = listProjectedMcpServers({
      config: {
        mcp: {
          servers: {
            atlas: { url: "https://example.com/mcp", transport: "streamable-http" },
          },
        },
      },
    });
    expect(text).toContain("atlas");
  });

  it("builds diagnostics", async () => {
    me.mockResolvedValue({ apiKeyName: "dev-key", userEmail: "dev@example.com" });
    const text = await buildCursorDiagnostics({
      ctx: { sessionId: "sess-1", sessionKey: "agent:main:chat", agentId: "main" },
      bindingStore: {
        lookup: () => undefined,
        register: () => {},
        delete: () => {},
      },
      pluginConfig: { runtime: "local" },
    });
    expect(text).toContain("Cursor diagnostics");
    expect(text).toContain("dev@example.com");
  });
});
