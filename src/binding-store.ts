/**
 * Lease-aware Cursor binding store built on OpenClaw plugin-state `update`.
 */
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import {
  bindingStoreKey,
  normalizeCursorBinding,
  type CursorBindingIdentity,
  type CursorBindingStore,
  type StoredCursorBinding,
} from "./session-binding.js";

const BINDING_LEASE_STALE_MS = 125_000;
const BINDING_LEASE_WAIT_MS = BINDING_LEASE_STALE_MS + 5_000;
const BINDING_LEASE_RENEW_INTERVAL_MS = Math.floor(BINDING_LEASE_STALE_MS / 3);
const BINDING_LEASE_RETRY_INTERVAL_MS = 1_000;

type InternalStoredCursorBinding = StoredCursorBinding & {
  lease?: { token: string; expiresAt: number };
};

type BindingLeaseOwner = {
  token: string;
  failure?: Error;
};

export type CursorStateStore = {
  lookup: (key: string) => InternalStoredCursorBinding | undefined;
  register: (key: string, value: InternalStoredCursorBinding) => void;
  delete: (key: string) => void;
  update?: (
    key: string,
    updateValue: (current: InternalStoredCursorBinding | undefined) => InternalStoredCursorBinding | undefined,
  ) => boolean;
};

type StateStore = CursorStateStore;

/**
 * Process-local keyed store for npm / untrusted installs where OpenClaw
 * blocks `openSyncKeyedStore` (official catalog / bundled only).
 */
export function createInMemoryCursorStateStore(options?: {
  maxEntries?: number;
}): CursorStateStore {
  const maxEntries = options?.maxEntries;
  const map = new Map<string, InternalStoredCursorBinding>();

  const setEntry = (key: string, value: InternalStoredCursorBinding): void => {
    if (maxEntries !== undefined && !map.has(key) && map.size >= maxEntries) {
      throw new Error(
        `Cursor binding store is full (${maxEntries} entries); reject-new overflow policy`,
      );
    }
    map.set(key, value);
  };

  return {
    lookup: (key) => map.get(key),
    register: (key, value) => {
      setEntry(key, value);
    },
    delete: (key) => {
      map.delete(key);
    },
    update: (key, updateValue) => {
      const next = updateValue(map.get(key));
      if (next === undefined) {
        map.delete(key);
        return true;
      }
      setEntry(key, next);
      return true;
    },
  };
}

function loadBindingsFromFile(filePath: string): Map<string, InternalStoredCursorBinding> {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return new Map();
    }
    const map = new Map<string, InternalStoredCursorBinding>();
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const binding = normalizeCursorBinding(value);
      if (!binding) {
        continue;
      }
      const lease =
        value && typeof value === "object" && "lease" in value
          ? (value as InternalStoredCursorBinding).lease
          : undefined;
      map.set(key, lease ? { ...binding, lease } : binding);
    }
    return map;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Map();
    }
    return new Map();
  }
}

function persistBindingsFile(
  filePath: string,
  map: Map<string, InternalStoredCursorBinding>,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = Object.fromEntries(map.entries());
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * Durable keyed store for npm / untrusted installs where OpenClaw blocks
 * `openSyncKeyedStore`. Persists under the instance state dir (volume).
 */
export function createFileCursorStateStore(options: {
  path: string;
  maxEntries?: number;
}): CursorStateStore {
  const filePath = options.path;
  const maxEntries = options.maxEntries;
  const map = loadBindingsFromFile(filePath);

  const setEntry = (key: string, value: InternalStoredCursorBinding): void => {
    if (maxEntries !== undefined && !map.has(key) && map.size >= maxEntries) {
      throw new Error(
        `Cursor binding store is full (${maxEntries} entries); reject-new overflow policy`,
      );
    }
    map.set(key, value);
  };

  const persist = (): void => {
    persistBindingsFile(filePath, map);
  };

  return {
    lookup: (key) => map.get(key),
    register: (key, value) => {
      setEntry(key, value);
      persist();
    },
    delete: (key) => {
      map.delete(key);
      persist();
    },
    update: (key, updateValue) => {
      const next = updateValue(map.get(key));
      if (next === undefined) {
        map.delete(key);
      } else {
        setEntry(key, next);
      }
      persist();
      return true;
    },
  };
}

export type CursorBindingLeaseStore = CursorBindingStore & {
  withLease<T>(identity: CursorBindingIdentity, run: () => Promise<T>): Promise<T>;
};

/** Runs a mutation under a binding lease when the store supports it. */
export async function withCursorBindingLease<T>(
  store: CursorBindingStore,
  identity: CursorBindingIdentity,
  run: () => Promise<T> | T,
): Promise<T> {
  if ("withLease" in store && typeof store.withLease === "function") {
    return await (store as CursorBindingLeaseStore).withLease(identity, async () => await run());
  }
  return await run();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bindingLeaseLostError(key: string, cause?: unknown): Error {
  return new Error(`Lost Cursor binding lease: ${key}`, cause === undefined ? undefined : { cause });
}

function readInternal(value: unknown): InternalStoredCursorBinding | undefined {
  const binding = normalizeCursorBinding(value);
  if (!binding) {
    return undefined;
  }
  const lease =
    value && typeof value === "object" && "lease" in value
      ? (value as InternalStoredCursorBinding).lease
      : undefined;
  return lease ? { ...binding, lease } : binding;
}

function stripLease(binding: InternalStoredCursorBinding): StoredCursorBinding {
  const { lease: _lease, ...rest } = binding;
  return rest;
}

/** Creates a binding store with transactional leases when `update` is available. */
export function createCursorBindingStore(state: StateStore): CursorBindingLeaseStore {
  const leaseContext = new AsyncLocalStorage<Map<string, BindingLeaseOwner>>();

  const renewLease = (key: string, owner: BindingLeaseOwner, update: NonNullable<StateStore["update"]>): void => {
    if (owner.failure) {
      return;
    }
    try {
      let renewed = false;
      const stored = update(key, (current) => {
        const lease = current?.lease;
        const now = Date.now();
        if (!lease || lease.token !== owner.token || lease.expiresAt <= now) {
          return undefined;
        }
        renewed = true;
        return {
          ...(current ?? { schemaVersion: 1, agentId: "", compatKey: "", runtime: "local", updatedAt: now }),
          lease: { token: owner.token, expiresAt: now + BINDING_LEASE_STALE_MS },
        };
      });
      if (!renewed || !stored) {
        owner.failure = bindingLeaseLostError(key);
      }
    } catch (error) {
      owner.failure = bindingLeaseLostError(key, error);
    }
  };

  const transactKey = async <T>(
    key: string,
    apply: (
      current: InternalStoredCursorBinding | undefined,
      leaseToken?: string,
    ) => { next?: InternalStoredCursorBinding; result: T },
  ): Promise<T> => {
    const update = state.update;
    if (!update) {
      throw new Error("Cursor binding leases require plugin-state update support");
    }
    const deadline = Date.now() + BINDING_LEASE_WAIT_MS;
    while (true) {
      let busy = false;
      let result!: T;
      const ownedLease = leaseContext.getStore()?.get(key);
      const applied = update(key, (current) => {
        const now = Date.now();
        const lease = current?.lease;
        if (lease && lease.expiresAt > now) {
          if (!ownedLease || ownedLease.token !== lease.token) {
            busy = true;
            return current;
          }
        }
        const outcome = apply(current, ownedLease?.token);
        result = outcome.result;
        return outcome.next;
      });
      if (busy) {
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for Cursor binding lease: ${key}`);
        }
        await sleep(BINDING_LEASE_RETRY_INTERVAL_MS);
        continue;
      }
      if (!applied) {
        throw new Error(`Cursor binding transaction failed: ${key}`);
      }
      return result;
    }
  };

  const base: CursorBindingStore = {
    lookup(key) {
      return normalizeCursorBinding(state.lookup(key));
    },
    register(key, binding) {
      const owner = leaseContext.getStore()?.get(key);
      const current = readInternal(state.lookup(key));
      if (current?.lease) {
        const now = Date.now();
        if (
          !owner ||
          owner.token !== current.lease.token ||
          current.lease.expiresAt <= now
        ) {
          throw new Error(`Cursor binding lease required for ${key}`);
        }
      }
      if (state.update) {
        state.update(key, () => ({
          ...binding,
          ...(current?.lease ? { lease: current.lease } : {}),
        }));
        return;
      }
      state.register(key, binding);
    },
    delete(key) {
      const owner = leaseContext.getStore()?.get(key);
      const current = readInternal(state.lookup(key));
      if (current?.lease) {
        const now = Date.now();
        if (
          !owner ||
          owner.token !== current.lease.token ||
          current.lease.expiresAt <= now
        ) {
          throw new Error(`Cursor binding lease required for ${key}`);
        }
      }
      state.delete(key);
    },
  };

  if (!state.update) {
    return {
      ...base,
      async withLease(_identity, run) {
        return await run();
      },
    };
  }

  return {
    ...base,
    async withLease(identity, run) {
      const key = bindingStoreKey(identity);
      const owned = leaseContext.getStore();
      const existingOwner = owned?.get(key);
      if (existingOwner) {
        if (existingOwner.failure) {
          throw existingOwner.failure;
        }
        const result = await run();
        if (existingOwner.failure) {
          throw existingOwner.failure;
        }
        return result;
      }

      const token = randomUUID();
      const acquired = await transactKey(key, (current) => {
        const lease = { token, expiresAt: Date.now() + BINDING_LEASE_STALE_MS };
        return {
          result: true,
          next: current
            ? { ...current, lease }
            : {
                schemaVersion: 1,
                agentId: "",
                compatKey: "",
                runtime: "local",
                updatedAt: Date.now(),
                lease,
              },
        };
      });
      if (!acquired) {
        throw new Error(`Could not acquire Cursor binding lease: ${key}`);
      }

      const owner: BindingLeaseOwner = { token };
      const nested = new Map(owned);
      nested.set(key, owner);
      const heartbeat = setInterval(
        () => renewLease(key, owner, state.update!),
        BINDING_LEASE_RENEW_INTERVAL_MS,
      );
      heartbeat.unref();
      try {
        const result = await leaseContext.run(nested, run);
        if (owner.failure) {
          throw owner.failure;
        }
        return result;
      } finally {
        clearInterval(heartbeat);
        try {
          state.update!(key, (current) => {
            if (!current?.lease || current.lease.token !== token) {
              return current;
            }
            const { lease: _lease, ...released } = current;
            if (released.agentId && released.compatKey) {
              return released;
            }
            return undefined;
          });
        } catch {
          // Lease expires on its own after owner disconnect.
        }
      }
    },
  };
}
