/**
 * Merge Cursor SDK customTools maps without dropping bridged OpenClaw tools.
 */
import type { SDKCustomTool } from "@cursor/sdk";

export function mergeCursorCustomTools(
  ...parts: Array<Record<string, SDKCustomTool> | undefined>
): Record<string, SDKCustomTool> | undefined {
  const merged: Record<string, SDKCustomTool> = {};
  for (const part of parts) {
    if (!part) {
      continue;
    }
    Object.assign(merged, part);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}
