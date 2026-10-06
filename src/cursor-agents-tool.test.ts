import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/core", () => ({
  jsonResult: (value: unknown) => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
  }),
  readStringParam: (
    params: Record<string, unknown>,
    key: string,
    options?: { required?: boolean; label?: string },
  ) => {
    const value = params[key];
    if (typeof value !== "string" || !value.trim()) {
      if (options?.required) {
        throw new Error(`${options.label ?? key} is required`);
      }
      return undefined;
    }
    return value.trim();
  },
}));

const { list, get, messagesList } = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  messagesList: vi.fn(),
}));

vi.mock("@cursor/sdk", () => ({
  Agent: {
    list,
    get,
    messages: { list: messagesList },
  },
}));

import { createCursorAgentsTool } from "./cursor-agents-tool.js";
import { createCursorBindingStore } from "./binding-store.js";

function memoryStore() {
  const map = new Map<string, unknown>();
  const state = {
    lookup: (key: string) => map.get(key) as never,
    register: (key: string, value: unknown) => {
      map.set(key, value);
    },
    delete: (key: string) => {
      map.delete(key);
    },
    update: (key: string, updateValue: (current: unknown) => unknown) => {
      const next = updateValue(map.get(key));
      if (next === undefined) {
        map.delete(key);
        return true;
      }
      map.set(key, next);
      return true;
    },
  };
  return { store: createCursorBindingStore(state), map };
}

describe("cursor_agents tool", () => {
  beforeEach(() => {
    list.mockReset();
    get.mockReset();
    messagesList.mockReset();
    process.env.CURSOR_API_KEY = "test-key";
  });

  it("lists agents", async () => {
    list.mockResolvedValue({ items: [{ agentId: "a-1", name: "One" }] });
    const tool = createCursorAgentsTool({
      bindingStore: memoryStore().store,
      context: {},
      getPluginConfig: () => ({ runtime: "local" }),
    });
    const result = await tool.execute("call-1", { action: "list" });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      items: [{ agentId: "a-1" }],
    });
  });

  it("attaches an agent to the current session on resume", async () => {
    get.mockResolvedValue({ agentId: "agent-9", name: "Existing" });
    const { store, map } = memoryStore();
    const tool = createCursorAgentsTool({
      bindingStore: store,
      context: { sessionId: "sess-1", sessionKey: "agent:main:chat", agentId: "main" },
      getPluginConfig: () => ({ runtime: "local" }),
    });
    const result = await tool.execute("call-2", {
      action: "resume",
      agent_id: "agent-9",
      attach: true,
    });
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.attached).toBe(true);
    expect(map.size).toBeGreaterThan(0);
  });
});
