import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCursorConversationBindingData,
} from "./conversation-binding-data.js";
import { handleCursorConversationInboundClaim } from "./conversation-binding.js";
import type { CursorBindingStore } from "./session-binding.js";

const { create, resume, send } = vi.hoisted(() => ({
  create: vi.fn(),
  resume: vi.fn(),
  send: vi.fn(),
}));

const { buildCursorToolBridge } = vi.hoisted(() => ({
  buildCursorToolBridge: vi.fn(),
}));

vi.mock("@cursor/sdk", () => ({
  Agent: { create, resume },
}));

vi.mock("./tool-bridge.js", () => ({
  buildCursorToolBridge,
}));

function memoryStore(): CursorBindingStore {
  const map = new Map();
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

describe("handleCursorConversationInboundClaim", () => {
  beforeEach(() => {
    create.mockReset();
    resume.mockReset();
    send.mockReset();
    buildCursorToolBridge.mockReset();
    process.env.CURSOR_API_KEY = "test-key";
    buildCursorToolBridge.mockResolvedValue({
      customTools: {
        message: {
          description: "send message",
          async execute() {
            return "sent";
          },
        },
      },
      telemetry: {
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
        toolMetas: [],
        toolMessages: [],
      },
    });
  });

  it("declines when binding data is missing", async () => {
    const result = await handleCursorConversationInboundClaim(
      { content: "hi", commandAuthorized: true },
      { pluginBinding: null },
      { bindingStore: memoryStore() },
    );
    expect(result).toBeUndefined();
  });

  it("swallows unauthorized commands", async () => {
    const data = createCursorConversationBindingData({ workspaceDir: "/tmp/ws" });
    const result = await handleCursorConversationInboundClaim(
      { content: "hi", commandAuthorized: false },
      { pluginBinding: { data } },
      { bindingStore: memoryStore() },
    );
    expect(result).toEqual({ handled: true });
  });

  it("runs a bound turn with customTools and returns assistant text", async () => {
    send.mockResolvedValue({
      id: "run-1",
      supports: (op: string) => op === "cancel" || op === "stream" || op === "wait",
      cancel: async () => undefined,
      stream: async function* () {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "hello from cursor" }] },
        };
      },
      wait: async () => ({ status: "finished" }),
    });
    create.mockResolvedValue({
      agentId: "agent-new",
      send,
      [Symbol.asyncDispose]: async () => undefined,
    });

    const data = createCursorConversationBindingData({
      bindingId: "bind-1",
      workspaceDir: "/tmp/ws",
      start: { id: "s1", model: "composer-2.5" },
    });
    const result = await handleCursorConversationInboundClaim(
      { content: "hi", commandAuthorized: true, channel: "telegram" },
      { pluginBinding: { data } },
      { bindingStore: memoryStore(), pluginConfig: { runtime: "local" } },
    );
    expect(result).toEqual({
      handled: true,
      reply: { text: "hello from cursor" },
    });
    expect(buildCursorToolBridge).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({
        local: expect.objectContaining({
          customTools: expect.objectContaining({ message: expect.any(Object) }),
        }),
      }),
    );
  });

  it("omits reply when messaging tool already delivered the response", async () => {
    buildCursorToolBridge.mockResolvedValue({
      customTools: { message: { description: "send", async execute() { return "ok"; } } },
      telemetry: {
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["sent via tool"],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
        toolMetas: [],
        toolMessages: [],
      },
    });
    send.mockResolvedValue({
      id: "run-2",
      supports: () => true,
      cancel: async () => undefined,
      stream: async function* () {},
      wait: async () => ({ status: "finished" }),
    });
    create.mockResolvedValue({
      agentId: "agent-new",
      send,
      [Symbol.asyncDispose]: async () => undefined,
    });
    const data = createCursorConversationBindingData({
      bindingId: "bind-2",
      workspaceDir: "/tmp/ws",
      start: { id: "s2" },
    });
    const result = await handleCursorConversationInboundClaim(
      { content: "reply in channel", commandAuthorized: true },
      { pluginBinding: { data } },
      { bindingStore: memoryStore(), pluginConfig: { runtime: "local" } },
    );
    expect(result).toEqual({ handled: true });
  });
});
