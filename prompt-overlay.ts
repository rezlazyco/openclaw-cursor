/**
 * Cursor system-prompt contribution (kept light; Cursor owns most agent instructions).
 */
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { readCursorPluginConfig } from "./src/config.js";

export function resolveCursorSystemPromptContribution(params: {
  config?: unknown;
  modelId?: string;
}): {
  stablePrefix?: string;
  dynamicSuffix?: string;
} {
  const pluginConfig = readCursorPluginConfig(
    resolvePluginConfigObject(params.config, "cursor") ?? params.config,
  );

  const stablePrefix = [
    "You are running as the Cursor agent harness inside OpenClaw.",
    "Prefer repository tools and edits through the Cursor runtime.",
    "Keep channel-facing replies concise unless the user asks for detail.",
  ].join(" ");

  const dynamicSuffix =
    pluginConfig.runtime === "local" && pluginConfig.local.backgroundJobs.enabled
      ? [
          "Background jobs (openclaw_background_job): at the start of each user turn, decide whether the request is LARGE or should run asynchronously.",
          "Treat as LARGE / background when any apply: user asks to run in the background or notify later;",
          "multi-step implementation (new site, feature, refactor, many files);",
          "expected to need many tool calls or more than ~1 minute;",
          "user says the task is big / «большая задача» / «запусти работу» / «сделай и отпиши».",
          "If LARGE or async: your FIRST tool call MUST be openclaw_background_job with action=spawn and task=the full user request (do not use Read/Write/Shell for the main work in this turn).",
          "Then reply briefly with ONLY the real jobId from the tool JSON — never invent a UUID in text.",
          "If SMALL (one quick answer, single file tweak, status question): handle inline; do not spawn.",
          "Never claim a background job is running without a successful spawn in this turn.",
          "For progress use openclaw_background_job action=status or action=list.",
          "When a background job finishes, OpenClaw delivers the result on the same session/channel.",
        ].join(" ")
      : undefined;

  return {
    stablePrefix,
    ...(dynamicSuffix ? { dynamicSuffix } : {}),
  };
}
