import { describe, expect, it } from "vitest";
import {
  createCursorConversationBindingData,
  readCursorConversationBindingData,
  readCursorConversationBindingDataRecord,
} from "./conversation-binding-data.js";
import { createCursorCommand, handleCursorCommand } from "./commands.js";
import {
  bindingStoreKey,
  conversationBindingIdentity,
  type CursorBindingStore,
  type StoredCursorBinding,
} from "./session-binding.js";
import { handleCursorConversationBindingResolved } from "./conversation-binding.js";

function conversationKey(bindingId: string): string {
  return bindingStoreKey(conversationBindingIdentity(bindingId));
}

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

describe("conversation binding data", () => {
  it("creates and reads cursor-sdk-session payloads", () => {
    const data = createCursorConversationBindingData({
      workspaceDir: "/tmp/ws",
      agentId: "main",
      start: { id: "start-1", model: "composer-2.5" },
    });
    expect(data.kind).toBe("cursor-sdk-session");
    expect(data.workspaceDir).toBe("/tmp/ws");
    expect(readCursorConversationBindingData({ data })).toEqual(data);
  });

  it("rejects foreign binding kinds", () => {
    expect(
      readCursorConversationBindingDataRecord({
        kind: "codex-app-server-session",
        version: 2,
        bindingId: "x",
        workspaceDir: "/tmp",
      }),
    ).toBeUndefined();
  });
});

describe("/cursor commands", () => {
  it("returns help", async () => {
    const result = await handleCursorCommand(
      {
        args: "help",
        requestConversationBinding: async () => ({ status: "bound" }),
        detachConversationBinding: async () => ({ removed: false }),
        getCurrentConversationBinding: async () => null,
      },
      { bindingStore: memoryStore() },
    );
    expect(result.text).toContain("/cursor bind");
  });

  it("requests a conversation bind", async () => {
    let captured: unknown;
    const result = await handleCursorCommand(
      {
        args: "bind bc-123 --cwd /tmp/ws --model composer-2.5",
        sessionId: "sess-1",
        agentId: "main",
        requestConversationBinding: async (params) => {
          captured = params;
          return { status: "bound" };
        },
        detachConversationBinding: async () => ({ removed: false }),
        getCurrentConversationBinding: async () => null,
      },
      {
        bindingStore: memoryStore({
          "sess-1": {
            schemaVersion: 1,
            agentId: "existing-agent",
            compatKey: "k",
            runtime: "local",
            updatedAt: 1,
          },
        }),
      },
    );
    expect(result.text).toContain("Bound this conversation");
    expect(captured).toMatchObject({
      detachHint: "/cursor detach",
      data: {
        kind: "cursor-sdk-session",
        workspaceDir: "/tmp/ws",
        start: { cursorAgentId: "bc-123", model: "composer-2.5" },
        source: { cursorAgentId: "existing-agent", sessionId: "sess-1" },
      },
    });
  });

  it("detaches and clears store row", async () => {
    const store = memoryStore({
      [conversationKey("bind-1")]: {
        schemaVersion: 1,
        agentId: "agent-1",
        compatKey: "k",
        runtime: "local",
        updatedAt: 1,
      },
    });
    const result = await handleCursorCommand(
      {
        args: "detach",
        requestConversationBinding: async () => ({ status: "bound" }),
        detachConversationBinding: async () => ({ removed: true }),
        getCurrentConversationBinding: async () => ({
          bindingId: "host-1",
          data: createCursorConversationBindingData({
            bindingId: "bind-1",
            workspaceDir: "/tmp/ws",
          }),
        }),
      },
      { bindingStore: store },
    );
    expect(result.text).toContain("Detached");
    expect(store.lookup(conversationKey("bind-1"))).toBeUndefined();
  });

  it("creates a command definition without reserved ownership by default", () => {
    const command = createCursorCommand({ bindingStore: memoryStore() });
    expect(command.name).toBe("cursor");
    expect(command.ownership).toBeUndefined();
  });

  it("supports reserved ownership for bundled installs", () => {
    const command = createCursorCommand(
      { bindingStore: memoryStore() },
      { reservedOwnership: true },
    );
    expect(command.ownership).toBe("reserved");
  });
});

describe("conversation binding resolved", () => {
  it("clears store on denied bind", async () => {
    const data = createCursorConversationBindingData({
      bindingId: "bind-denied",
      workspaceDir: "/tmp/ws",
    });
    const store = memoryStore({
      [conversationKey(data.bindingId)]: {
        schemaVersion: 1,
        agentId: "a",
        compatKey: "k",
        runtime: "local",
        updatedAt: 1,
      },
    });
    await handleCursorConversationBindingResolved(
      { status: "denied", request: { data: data as unknown as Record<string, unknown> } },
      { bindingStore: store },
    );
    expect(store.lookup(conversationKey(data.bindingId))).toBeUndefined();
  });
});
