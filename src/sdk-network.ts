/**
 * Apply Cursor SDK network defaults (HTTP/1.1 behind proxies).
 */
import { Cursor } from "@cursor/sdk";
import type { CursorPluginConfig } from "./config.js";

/** Configures Cursor SDK transport options from plugin config. */
export function applyCursorSdkNetworkConfig(pluginConfig: CursorPluginConfig): void {
  if (!pluginConfig.local.useHttp1ForAgent) {
    return;
  }
  Cursor.configure({
    local: {
      useHttp1ForAgent: true,
    },
  });
}
