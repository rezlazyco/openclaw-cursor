/**
 * In-process active Cursor run tracking for /cursor stop.
 * Cursor SDK supports run.cancel(); there is no steer RPC.
 */
export type CursorActiveRun = {
  runId: string;
  agentId: string;
  cancel: () => Promise<void>;
  supportsCancel: boolean;
  startedAt: number;
};

const CURSOR_ACTIVE_RUN_STATE = Symbol.for("openclaw.cursor.activeRuns");

function getActiveRuns(): Map<string, CursorActiveRun> {
  const globalState = globalThis as typeof globalThis & {
    [CURSOR_ACTIVE_RUN_STATE]?: Map<string, CursorActiveRun>;
  };
  globalState[CURSOR_ACTIVE_RUN_STATE] ??= new Map();
  return globalState[CURSOR_ACTIVE_RUN_STATE];
}

/** Registers an active run until the returned disposer is called. */
export function trackCursorActiveRun(key: string, active: CursorActiveRun): () => void {
  const runs = getActiveRuns();
  runs.set(key, active);
  return () => {
    const current = runs.get(key);
    if (current?.runId === active.runId) {
      runs.delete(key);
    }
  };
}

export function readCursorActiveRun(key: string): CursorActiveRun | undefined {
  return getActiveRuns().get(key);
}

/** Cancels an active Cursor run for the given binding/session key. */
export async function stopCursorActiveRun(
  key: string,
): Promise<{ stopped: boolean; message: string }> {
  const active = readCursorActiveRun(key);
  if (!active) {
    return { stopped: false, message: "No active Cursor run to stop." };
  }
  if (!active.supportsCancel) {
    return {
      stopped: false,
      message: "Active Cursor run does not support cancel on this runtime.",
    };
  }
  try {
    await active.cancel();
    return { stopped: true, message: "Cursor stop requested." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stopped: false, message: `Cursor stop failed: ${message}` };
  }
}
