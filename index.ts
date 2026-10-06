/**
 * Bundled Cursor plugin entry: SDK harness, model provider, and session binding hooks.
 */
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry, type OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createCursorAgentHarness,
  CURSOR_BINDING_MAX_ENTRIES,
  CURSOR_BINDING_NAMESPACE,
} from "./harness.js";
import { buildCursorProvider } from "./provider.js";
import {
  createCursorBindingStore,
  createFileCursorStateStore,
  withCursorBindingLease,
} from "./src/binding-store.js";
import { createCursorCommand } from "./src/commands.js";
import { createCursorAgentsTool } from "./src/cursor-agents-tool.js";
import {
  handleCursorConversationBindingResolved,
  handleCursorConversationInboundClaim,
} from "./src/conversation-binding.js";
import {
  adoptSessionGeneration,
  retireSessionGeneration,
  sessionBindingIdentity,
} from "./src/session-binding.js";
import { ensureCursorRipgrepConfigured } from "./src/ripgrep.js";
import { readCursorPluginConfig } from "./src/config.js";
import { applyCursorSdkNetworkConfig } from "./src/sdk-network.js";

const ENDED_SESSION_REASONS: ReadonlySet<string> = new Set([
  "new",
  "reset",
  "idle",
  "daily",
  "deleted",
]);

let loggedFileBindingFallback = false;

type PluginLogger = {
  warn?: (message: string) => void;
  debug?: (message: string) => void;
};

function logFileBindingFallback(
  logger: PluginLogger,
  bindingsPath: string,
  reason: string,
): void {
  if (!loggedFileBindingFallback) {
    loggedFileBindingFallback = true;
    logger.warn?.(
      `cursor: OpenClaw keyed store unavailable (${reason}); using file bindings at ${bindingsPath}`,
    );
    return;
  }
  logger.debug?.(`cursor: file bindings at ${bindingsPath}`);
}

export default definePluginEntry({
  id: "cursor",
  name: "Cursor",
  description: "Cursor SDK harness and Cursor-managed model catalog.",
  register(api) {
    ensureCursorRipgrepConfigured(api.logger);
    applyCursorSdkNetworkConfig(readCursorPluginConfig(api.pluginConfig));

    const resolveCurrentConfig = () =>
      api.runtime.config?.current ? (api.runtime.config.current() as OpenClawConfig) : undefined;
    const resolveCurrentPluginConfig = () =>
      resolveLivePluginConfigObject(
        resolveCurrentConfig,
        "cursor",
        api.pluginConfig as Record<string, unknown>,
      ) ?? api.pluginConfig;

    // Always register harness + provider, including discovery / non-full loads.
    // OpenClaw prepared-run needs the harness id in the registry before it can
    // fully activate an on-demand harness plugin (same pattern as bundled Codex).
    // openSyncKeyedStore is gated to bundled / official-catalog installs;
    // third-party packages fall back to a JSON file under the state dir.
    const keyedState = (() => {
      try {
        return api.runtime.state.openSyncKeyedStore({
          namespace: CURSOR_BINDING_NAMESPACE,
          maxEntries: CURSOR_BINDING_MAX_ENTRIES,
          overflowPolicy: "reject-new",
        }) as Parameters<typeof createCursorBindingStore>[0];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const bindingsPath = path.join(
          api.runtime.state.resolveStateDir(),
          "cursor",
          "bindings.json",
        );
        logFileBindingFallback(api.logger, bindingsPath, message);
        return createFileCursorStateStore({
          path: bindingsPath,
          maxEntries: CURSOR_BINDING_MAX_ENTRIES,
        });
      }
    })();
    const bindingStore = createCursorBindingStore(keyedState);

    api.registerAgentHarness(
      createCursorAgentHarness({
        bindingStore,
        resolveConfig: resolveCurrentConfig,
        resolvePluginConfig: resolveCurrentPluginConfig,
      }),
    );
    api.registerProvider(buildCursorProvider({ pluginConfig: api.pluginConfig }));

    if (api.registrationMode !== "full") {
      return;
    }

    api.registerTool(
      (context: OpenClawPluginToolContext) =>
        createCursorAgentsTool({
          bindingStore,
          context,
          getPluginConfig: resolveCurrentPluginConfig,
          getConfig: resolveCurrentConfig,
        }),
      { name: "cursor_agents" },
    );
    api.registerToolMetadata?.({
      toolName: "cursor_agents",
      displayName: "Cursor Agents",
      description: "List, inspect, and attach Cursor SDK agents for the current user.",
      risk: "high",
      tags: ["cursor", "sessions"],
    });
    api.registerCommand(
      createCursorCommand({
        bindingStore,
        resolvePluginConfig: resolveCurrentPluginConfig,
      }),
    );

    api.on("inbound_claim", (event: unknown, ctx: unknown) =>
      handleCursorConversationInboundClaim(
        event as Parameters<typeof handleCursorConversationInboundClaim>[0],
        ctx as Parameters<typeof handleCursorConversationInboundClaim>[1],
        {
          bindingStore,
          resolvePluginConfig: resolveCurrentPluginConfig,
          config: resolveCurrentConfig(),
        },
      ),
    );
    api.onConversationBindingResolved?.((event: unknown) =>
      handleCursorConversationBindingResolved(
        event as Parameters<typeof handleCursorConversationBindingResolved>[0],
        { bindingStore },
      ),
    );

    api.on(
      "after_compaction",
      async (
        event: { previousSessionId?: string },
        ctx: { sessionId?: string; sessionKey?: string; agentId?: string },
      ) => {
        const previousSessionId = event.previousSessionId?.trim();
        const sessionId = ctx.sessionId?.trim();
        if (!previousSessionId || !sessionId || previousSessionId === sessionId) {
          return;
        }
        try {
          const identity = sessionBindingIdentity({
            sessionId,
            sessionKey: ctx.sessionKey,
            agentId: ctx.agentId,
            config: resolveCurrentConfig(),
          });
          const adopted = await withCursorBindingLease(bindingStore, identity, async () =>
            adoptSessionGeneration(bindingStore, identity, previousSessionId),
          );
          if (adopted === "conflict") {
            api.logger.warn?.(
              `cursor: could not adopt compacted session generation ${sessionId} (${adopted})`,
            );
          }
        } catch {
          api.logger.warn?.(
            `cursor: could not adopt compacted session generation ${sessionId}`,
          );
        }
      },
    );

    api.on(
      "session_end",
      async (
        event: { reason?: string; sessionId?: string; sessionKey?: string },
        ctx: { sessionId?: string; sessionKey?: string; agentId?: string },
      ) => {
        if (!event.reason || !ENDED_SESSION_REASONS.has(event.reason)) {
          return;
        }
        const sessionId = event.sessionId ?? ctx.sessionId;
        if (!sessionId) {
          return;
        }
        try {
          await withCursorBindingLease(
            bindingStore,
            sessionBindingIdentity({
              sessionId,
              sessionKey: event.sessionKey ?? ctx.sessionKey,
              agentId: ctx.agentId,
              config: resolveCurrentConfig(),
            }),
            async () =>
              retireSessionGeneration(
                bindingStore,
                sessionBindingIdentity({
                  sessionId,
                  sessionKey: event.sessionKey ?? ctx.sessionKey,
                  agentId: ctx.agentId,
                  config: resolveCurrentConfig(),
                }),
              ),
          );
        } catch {
          // Best-effort binding retirement.
        }
      },
    );
  },
});
