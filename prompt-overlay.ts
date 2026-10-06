/**
 * Cursor system-prompt contribution (kept light; Cursor owns most agent instructions).
 */
export function resolveCursorSystemPromptContribution(_params: {
  config?: unknown;
  modelId?: string;
}): {
  stablePrefix?: string;
  dynamicSuffix?: string;
} {
  return {
    stablePrefix: [
      "You are running as the Cursor agent harness inside OpenClaw.",
      "Prefer repository tools and edits through the Cursor runtime.",
      "Keep channel-facing replies concise unless the user asks for detail.",
    ].join(" "),
  };
}
