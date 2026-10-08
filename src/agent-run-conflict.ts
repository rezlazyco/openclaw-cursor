/** Cursor SDK rejects a second `agent.send` while a run is still active on that agent. */
export function isCursorActiveRunConflict(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : error !== undefined && error !== null ? String(error) : "";
  return message.includes("already has active run");
}
