import { describe, expect, it } from "vitest";
import { readCursorPluginConfig } from "./config.js";
import {
  adoptSessionGeneration,
  bindingStoreKey,
  computeCursorCompatKey,
  conversationBindingIdentity,
  lookupSessionBinding,
  normalizeCursorBinding,
  retireSessionGeneration,
  sessionBindingIdentity,
} from "./session-binding.js";

describe("readCursorPluginConfig", () => {
  it("applies defaults", () => {
    const config = readCursorPluginConfig(undefined);
    expect(config.runtime).toBe("local");
    expect(config.apiKeyEnv).toBe("CURSOR_API_KEY");
    expect(config.local.settingSources).toEqual([]);
    expect(config.local.backgroundJobs.enabled).toBe(true);
    expect(config.local.backgroundJobs.maxConcurrent).toBe(2);
    expect(config.local.backgroundJobs.notifyOnComplete).toBe(true);
    expect(config.local.backgroundJobs.persistJobs).toBe(false);
  });

  it("reads cloud runtime", () => {
    const config = readCursorPluginConfig({
      runtime: "cloud",
      cloud: { repoUrl: "https://github.com/acme/repo", autoCreatePR: true },
    });
    expect(config.runtime).toBe("cloud");
    expect(config.cloud.repoUrl).toBe("https://github.com/acme/repo");
    expect(config.cloud.autoCreatePR).toBe(true);
  });

  it("reads local.autoReview", () => {
    const config = readCursorPluginConfig({
      local: { autoReview: true, sandboxEnabled: true },
    });
    expect(config.local.autoReview).toBe(true);
    expect(config.local.sandboxEnabled).toBe(true);
  });

  it("reads local.backgroundJobs", () => {
    const config = readCursorPluginConfig({
      local: {
        backgroundJobs: {
          enabled: false,
          maxConcurrent: 5,
          notifyOnComplete: false,
          persistJobs: true,
        },
      },
    });
    expect(config.local.backgroundJobs.enabled).toBe(false);
    expect(config.local.backgroundJobs.maxConcurrent).toBe(5);
    expect(config.local.backgroundJobs.notifyOnComplete).toBe(false);
    expect(config.local.backgroundJobs.persistJobs).toBe(true);
  });
});

describe("session binding", () => {
  it("normalizes valid bindings", () => {
    const binding = normalizeCursorBinding({
      schemaVersion: 1,
      agentId: "agent-123",
      compatKey: "provider=cursor|model=composer-2.5",
      runtime: "local",
      updatedAt: 1,
    });
    expect(binding?.agentId).toBe("agent-123");
  });

  it("rejects invalid bindings", () => {
    expect(normalizeCursorBinding({ schemaVersion: 1 })).toBeUndefined();
  });

  it("builds stable compat keys", () => {
    const key = computeCursorCompatKey({
      provider: "cursor",
      modelId: "composer-2.5",
      workspaceDir: "/tmp/ws",
      runtime: "local",
      apiKeyFingerprint: "abcd",
    });
    expect(key).toContain("provider=cursor");
    expect(key).toContain("model=composer-2.5");
  });

  it("prefers session-key stable store keys", () => {
    const identity = sessionBindingIdentity({
      sessionId: "sess-2",
      sessionKey: "agent:main:telegram:1",
      agentId: "main",
    });
    expect(bindingStoreKey(identity)).toMatch(/^session-key:main:/);
    expect(bindingStoreKey(identity)).toBe(
      bindingStoreKey(
        sessionBindingIdentity({
          sessionId: "sess-9",
          sessionKey: "agent:main:telegram:1",
          agentId: "main",
        }),
      ),
    );
  });

  it("adopts and retires session generations", () => {
    const map = new Map();
    const store = {
      lookup: (key: string) => map.get(key),
      register: (key: string, value: unknown) => {
        map.set(key, value);
      },
      delete: (key: string) => {
        map.delete(key);
      },
    };
    const first = sessionBindingIdentity({
      sessionId: "sess-1",
      sessionKey: "agent:main:chat",
      agentId: "main",
    });
    const key = bindingStoreKey(first);
    store.register(key, {
      schemaVersion: 1,
      agentId: "agent-1",
      compatKey: "k",
      runtime: "local",
      sessionId: "sess-1",
      updatedAt: 1,
    });
    const second = sessionBindingIdentity({
      sessionId: "sess-2",
      sessionKey: "agent:main:chat",
      agentId: "main",
    });
    expect(adoptSessionGeneration(store, second, "sess-1")).toBe("adopted");
    expect(lookupSessionBinding(store, second)?.sessionId).toBe("sess-2");
    expect(retireSessionGeneration(store, second)).toBe("applied");
    expect(lookupSessionBinding(store, second)).toBeUndefined();
  });

  it("builds conversation keys", () => {
    expect(bindingStoreKey(conversationBindingIdentity("bind-1"))).toBe("conversation:bind-1");
  });
});
