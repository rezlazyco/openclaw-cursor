/**
 * Serializes Cursor SDK turns that share the same OpenClaw session or binding key.
 * OpenClaw session lanes usually enforce this, but embedded failover can start a
 * second attempt in parallel while the first Cursor run is still active.
 */

const turnQueues = new Map<string, Promise<unknown>>();

/** Runs `task` after prior turns for the same `key` finish (errors do not block the queue). */
export async function enqueueAgentTurn<T>(key: string, task: () => Promise<T>): Promise<T> {
  const normalized = key.trim();
  if (!normalized) {
    return await task();
  }

  const previous = turnQueues.get(normalized) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => gate);
  turnQueues.set(normalized, next);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (turnQueues.get(normalized) === next) {
      turnQueues.delete(normalized);
    }
  }
}
