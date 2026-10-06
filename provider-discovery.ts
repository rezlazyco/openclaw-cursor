/**
 * Static provider discovery entry for Cursor, used before the full plugin entry
 * is loaded.
 */
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildCursorProviderConfig,
  CURSOR_PROVIDER_ID,
  CURSOR_SDK_AUTH_MARKER,
  FALLBACK_CURSOR_MODELS,
} from "./provider-catalog.js";

function resolveCursorPluginConfig(ctx: ProviderCatalogContext): unknown {
  return (ctx.config.plugins?.entries as Record<string, { config?: unknown } | undefined>)?.cursor
    ?.config;
}

async function runCursorCatalog(ctx: ProviderCatalogContext) {
  const { buildCursorProviderCatalog } = await import("./provider.js");
  return await buildCursorProviderCatalog({
    env: ctx.env,
    pluginConfig: resolveCursorPluginConfig(ctx),
  });
}

/** Provider discovery descriptor with static fallback and synthetic auth. */
export const cursorProviderDiscovery: ProviderPlugin = {
  id: CURSOR_PROVIDER_ID,
  label: "Cursor",
  docsPath: "/providers/models",
  // Required so OpenClaw auth lookup maps CURSOR_API_KEY → provider "cursor"
  // during discovery / prepared-run (before full plugin activation).
  envVars: ["CURSOR_API_KEY"],
  auth: [],
  catalog: {
    order: "late",
    run: runCursorCatalog,
  },
  staticCatalog: {
    order: "late",
    run: async () => ({
      provider: buildCursorProviderConfig(FALLBACK_CURSOR_MODELS),
    }),
  },
  resolveSyntheticAuth: () => ({
    apiKey: CURSOR_SDK_AUTH_MARKER,
    source: "cursor-sdk",
    mode: "token",
  }),
};

export default cursorProviderDiscovery;
