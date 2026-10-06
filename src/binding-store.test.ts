import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCursorBindingStore,
  createFileCursorStateStore,
  createInMemoryCursorStateStore,
} from "./binding-store.js";
import {
  bindingStoreKey,
  registerCursorBinding,
  sessionBindingIdentity,
} from "./session-binding.js";

function createMemoryState() {
  return createInMemoryCursorStateStore();
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("binding store leases", () => {
  it("serializes concurrent writers for the same identity", async () => {
    const state = createMemoryState();
    const store = createCursorBindingStore(state);
    const identity = sessionBindingIdentity({
      sessionId: "sess-1",
      sessionKey: "agent:main:chat",
      agentId: "main",
    });
    const key = bindingStoreKey(identity);
    let firstInside = false;
    let secondBlocked = true;

    const first = store.withLease(identity, async () => {
      firstInside = true;
      await new Promise((resolve) => setTimeout(resolve, 50));
      registerCursorBinding(store, key, {
        schemaVersion: 1,
        agentId: "agent-1",
        compatKey: "k1",
        runtime: "local",
        sessionId: "sess-1",
        updatedAt: Date.now(),
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = store.withLease(identity, async () => {
      secondBlocked = firstInside;
      registerCursorBinding(store, key, {
        schemaVersion: 1,
        agentId: "agent-2",
        compatKey: "k2",
        runtime: "local",
        sessionId: "sess-1",
        updatedAt: Date.now(),
      });
    });

    await Promise.all([first, second]);
    expect(secondBlocked).toBe(true);
    expect(store.lookup(key)?.agentId).toBe("agent-2");
  });

  it("rejects register without an active lease when a lease row exists", async () => {
    const state = createMemoryState();
    const store = createCursorBindingStore(state);
    const identity = sessionBindingIdentity({
      sessionId: "sess-2",
      sessionKey: "agent:main:chat-2",
      agentId: "main",
    });
    const key = bindingStoreKey(identity);
    state.register(key, {
      schemaVersion: 1,
      agentId: "agent-held",
      compatKey: "k",
      runtime: "local",
      sessionId: "sess-2",
      updatedAt: Date.now(),
      lease: { token: "foreign", expiresAt: Date.now() + 60_000 },
    });

    expect(() =>
      store.register(key, {
        schemaVersion: 1,
        agentId: "agent-race",
        compatKey: "k2",
        runtime: "local",
        sessionId: "sess-2",
        updatedAt: Date.now(),
      }),
    ).toThrow(/lease required/i);

    expect(() =>
      registerCursorBinding(store, key, {
        schemaVersion: 1,
        agentId: "agent-race-2",
        compatKey: "k3",
        runtime: "local",
        sessionId: "sess-2",
        updatedAt: Date.now(),
      }),
    ).toThrow(/lease required/i);
  });
});

describe("file cursor state store", () => {
  it("persists bindings across store instances", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-bindings-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "bindings.json");
    const first = createFileCursorStateStore({ path: filePath });
    const store = createCursorBindingStore(first);
    const identity = sessionBindingIdentity({
      sessionId: "sess-file",
      sessionKey: "agent:main:file",
      agentId: "main",
    });
    const key = bindingStoreKey(identity);

    await store.withLease(identity, async () => {
      registerCursorBinding(store, key, {
        schemaVersion: 1,
        agentId: "agent-file",
        compatKey: "kf",
        runtime: "local",
        sessionId: "sess-file",
        updatedAt: Date.now(),
      });
    });

    const reloaded = createFileCursorStateStore({ path: filePath });
    expect(reloaded.lookup(key)?.agentId).toBe("agent-file");
    expect(fs.existsSync(filePath)).toBe(true);
  });
});
