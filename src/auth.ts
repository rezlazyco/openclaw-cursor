/**
 * Cursor API key resolution for harness and provider discovery.
 */
import { CURSOR_SDK_AUTH_MARKER } from "../provider-catalog.js";
import type { CursorPluginConfig } from "./config.js";

export type ResolvedCursorAuth = {
  apiKey: string;
  source: "resolvedApiKey" | "env" | "synthetic";
};

/**
 * Resolves the Cursor API key for an attempt.
 * Prefers the OpenClaw-resolved credential, then the configured env var.
 * Synthetic `cursor-sdk` markers are not usable as real keys.
 */
export function resolveCursorApiKey(params: {
  pluginConfig: CursorPluginConfig;
  resolvedApiKey?: string;
  env?: NodeJS.ProcessEnv;
}): ResolvedCursorAuth {
  const env = params.env ?? process.env;
  const resolved = params.resolvedApiKey?.trim();
  if (resolved && resolved !== CURSOR_SDK_AUTH_MARKER) {
    return { apiKey: resolved, source: "resolvedApiKey" };
  }

  const fromEnv = env[params.pluginConfig.apiKeyEnv]?.trim();
  if (fromEnv) {
    return { apiKey: fromEnv, source: "env" };
  }

  if (resolved === CURSOR_SDK_AUTH_MARKER) {
    throw new Error(
      `Cursor auth marker "${CURSOR_SDK_AUTH_MARKER}" is not a real API key; set ${params.pluginConfig.apiKeyEnv}`,
    );
  }

  throw new Error(
    `Missing Cursor API key; set ${params.pluginConfig.apiKeyEnv} or configure an auth profile`,
  );
}
