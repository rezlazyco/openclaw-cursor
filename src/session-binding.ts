/**
 * Durable OpenClaw session ↔ Cursor agentId binding helpers.
 */
import { createHash } from "node:crypto";

export const CURSOR_BINDING_NAMESPACE = "cursor-sdk-sessions";
export const CURSOR_BINDING_MAX_ENTRIES = 5000;

export type StoredCursorBinding = {
  schemaVersion: 1;
  agentId: string;
  compatKey: string;
  runtime: "local" | "cloud";
  updatedAt: number;
  /** Physical OpenClaw session generation currently owning this binding. */
  sessionId?: string;
};

export type CursorBindingStore = {
  lookup(key: string): StoredCursorBinding | undefined;
  register(key: string, value: StoredCursorBinding): void;
  delete(key: string): void;
};

export type CursorBindingIdentity =
  | { kind: "session"; agentId: string; sessionId: string; sessionKey?: string }
  | { kind: "conversation"; bindingId: string };

export type CursorAdoptResult = "adopted" | "current" | "absent" | "conflict";
export type CursorRetireResult = "applied" | "absent" | "conflict";

function resolveAgentId(agentId?: string): string {
  const trimmed = agentId?.trim();
  return trimmed || "main";
}

/** Resolves the same agent scope OpenClaw uses for transcript/session ownership. */
export function sessionBindingIdentity(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  config?: unknown;
}): Extract<CursorBindingIdentity, { kind: "session" }> {
  void params.config;
  const sessionKey = params.sessionKey?.trim();
  return {
    kind: "session",
    agentId: resolveAgentId(params.agentId),
    sessionId: params.sessionId.trim(),
    ...(sessionKey ? { sessionKey } : {}),
  };
}

/** Conversation-scoped binding identity for channel binds. */
export function conversationBindingIdentity(
  bindingId: string,
): Extract<CursorBindingIdentity, { kind: "conversation" }> {
  return { kind: "conversation", bindingId: bindingId.trim() };
}

/** Stable plugin-state key for one current binding owner. */
export function bindingStoreKey(identity: CursorBindingIdentity): string {
  if (identity.kind === "conversation") {
    const bindingId = identity.bindingId.trim();
    if (!bindingId) {
      throw new Error("Cursor conversation binding requires a binding id");
    }
    return `conversation:${bindingId}`;
  }
  const agentId = identity.agentId.trim() || "main";
  const sessionId = identity.sessionId.trim();
  if (!sessionId) {
    throw new Error("Cursor session binding requires a session id");
  }
  const sessionKey = identity.sessionKey?.trim();
  if (sessionKey) {
    const digest = createHash("sha256").update(sessionKey).digest("base64url");
    return `session-key:${agentId}:${digest}`;
  }
  return `session:${agentId}:${sessionId}`;
}

/** @deprecated Prefer bindingStoreKey(conversationBindingIdentity(id)). */
export function conversationBindingStoreKey(bindingId: string): string {
  return bindingStoreKey(conversationBindingIdentity(bindingId));
}

export function normalizeCursorBinding(value: unknown): StoredCursorBinding | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Partial<StoredCursorBinding>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.agentId !== "string" ||
    !record.agentId.trim() ||
    typeof record.compatKey !== "string" ||
    !record.compatKey.trim() ||
    (record.runtime !== "local" && record.runtime !== "cloud") ||
    typeof record.updatedAt !== "number" ||
    !Number.isFinite(record.updatedAt)
  ) {
    return undefined;
  }
  const sessionId =
    typeof record.sessionId === "string" && record.sessionId.trim()
      ? record.sessionId.trim()
      : undefined;
  return {
    schemaVersion: 1,
    agentId: record.agentId.trim(),
    compatKey: record.compatKey,
    runtime: record.runtime,
    updatedAt: record.updatedAt,
    ...(sessionId ? { sessionId } : {}),
  };
}

export function lookupCursorBinding(
  store: CursorBindingStore | undefined,
  key: string,
): StoredCursorBinding | undefined {
  try {
    return normalizeCursorBinding(store?.lookup(key));
  } catch {
    try {
      store?.delete(key);
    } catch {
      // Best-effort cleanup of corrupt bindings.
    }
    return undefined;
  }
}

/**
 * Looks up a session binding by stable identity, with legacy raw-sessionId fallback.
 */
export function lookupSessionBinding(
  store: CursorBindingStore | undefined,
  identity: Extract<CursorBindingIdentity, { kind: "session" }>,
): StoredCursorBinding | undefined {
  const key = bindingStoreKey(identity);
  const current = lookupCursorBinding(store, key);
  if (current) {
    return current;
  }
  // Pre-stable-key installs stored bindings under the bare session id.
  const legacy = lookupCursorBinding(store, identity.sessionId);
  if (!legacy || !store) {
    return undefined;
  }
  registerCursorBinding(store, key, {
    ...legacy,
    sessionId: identity.sessionId,
    updatedAt: Date.now(),
  });
  deleteCursorBinding(store, identity.sessionId);
  return lookupCursorBinding(store, key);
}

function isBindingLeaseError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /binding lease required|lost cursor binding lease|timed out waiting for cursor binding lease/i.test(
      error.message,
    )
  );
}

export function registerCursorBinding(
  store: CursorBindingStore | undefined,
  key: string,
  binding: StoredCursorBinding,
): boolean {
  try {
    store?.register(key, binding);
    return true;
  } catch (error) {
    if (isBindingLeaseError(error)) {
      throw error;
    }
    try {
      store?.delete(key);
    } catch {
      // Persistence is optional; in-memory reuse still works for this process.
    }
    return false;
  }
}

export function deleteCursorBinding(
  store: CursorBindingStore | undefined,
  key: string,
): boolean {
  try {
    store?.delete(key);
    return true;
  } catch (error) {
    if (isBindingLeaseError(error)) {
      throw error;
    }
    return false;
  }
}

/**
 * Adopts a binding across OpenClaw session-id rotation after compaction.
 * With sessionKey-stable keys the row stays put and only sessionId updates.
 */
export function adoptSessionGeneration(
  store: CursorBindingStore | undefined,
  identity: Extract<CursorBindingIdentity, { kind: "session" }>,
  expectedPreviousSessionId: string,
): CursorAdoptResult {
  if (!store) {
    return "absent";
  }
  const expected = expectedPreviousSessionId.trim();
  const target = identity.sessionId.trim();
  if (!expected || !target) {
    return "absent";
  }

  if (identity.sessionKey?.trim()) {
    const key = bindingStoreKey(identity);
    const current = lookupCursorBinding(store, key);
    if (!current) {
      return "absent";
    }
    if (current.sessionId === target) {
      return "current";
    }
    if (current.sessionId && current.sessionId !== expected) {
      return "conflict";
    }
    registerCursorBinding(store, key, {
      ...current,
      sessionId: target,
      updatedAt: Date.now(),
    });
    return "adopted";
  }

  // Physical session keys rotate with the session id — move the row.
  const previousIdentity = { ...identity, sessionId: expected };
  const previousKey = bindingStoreKey(previousIdentity);
  const nextKey = bindingStoreKey(identity);
  const previous =
    lookupCursorBinding(store, previousKey) ?? lookupCursorBinding(store, expected);
  if (!previous) {
    const already = lookupCursorBinding(store, nextKey);
    return already ? (already.sessionId === target ? "current" : "conflict") : "absent";
  }
  if (lookupCursorBinding(store, nextKey)?.sessionId === target) {
    return "current";
  }
  registerCursorBinding(store, nextKey, {
    ...previous,
    sessionId: target,
    updatedAt: Date.now(),
  });
  deleteCursorBinding(store, previousKey);
  deleteCursorBinding(store, expected);
  return "adopted";
}

/** Retires the current session generation binding. */
export function retireSessionGeneration(
  store: CursorBindingStore | undefined,
  identity: Extract<CursorBindingIdentity, { kind: "session" }>,
): CursorRetireResult {
  if (!store) {
    return "absent";
  }
  const key = bindingStoreKey(identity);
  const current =
    lookupCursorBinding(store, key) ?? lookupCursorBinding(store, identity.sessionId);
  if (!current) {
    return "absent";
  }
  if (current.sessionId && current.sessionId !== identity.sessionId) {
    return "conflict";
  }
  deleteCursorBinding(store, key);
  deleteCursorBinding(store, identity.sessionId);
  return "applied";
}

/** Fingerprint of attempt params that must match for safe agent resume. */
export function computeCursorCompatKey(params: {
  provider: string;
  modelId: string;
  workspaceDir: string;
  runtime: "local" | "cloud";
  apiKeyFingerprint: string;
  cloudRepoUrl?: string;
  mcpFingerprint?: string;
}): string {
  return [
    `provider=${params.provider}`,
    `model=${params.modelId}`,
    `cwd=${params.workspaceDir}`,
    `runtime=${params.runtime}`,
    `auth=${params.apiKeyFingerprint}`,
    `repo=${params.cloudRepoUrl ?? ""}`,
    `mcp=${params.mcpFingerprint ?? ""}`,
  ].join("|");
}

/** Non-secret fingerprint of an API key for compat invalidation on rotation. */
export async function fingerprintSecret(value: string): Promise<string> {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
