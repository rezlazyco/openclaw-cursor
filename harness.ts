/**
 * Cursor agent harness registration and session binding lifecycle.
 */
import type {
  AgentHarness,
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  AgentHarnessCompactParams,
  AgentHarnessCompactResult,
  AgentHarnessResetParams,
  AgentHarnessSideQuestionParams,
  AgentHarnessSideQuestionResult,
  ContextEngineHostCapability,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  CURSOR_BINDING_MAX_ENTRIES,
  CURSOR_BINDING_NAMESPACE,
  registerCursorBinding,
  retireSessionGeneration,
  sessionBindingIdentity,
  type CursorBindingStore,
  type StoredCursorBinding,
} from "./src/session-binding.js";
import { withCursorBindingLease } from "./src/binding-store.js";

export {
  CURSOR_BINDING_MAX_ENTRIES,
  CURSOR_BINDING_NAMESPACE,
  type CursorBindingStore,
  type StoredCursorBinding,
};

const DEFAULT_CURSOR_HARNESS_PROVIDER_IDS = new Set(["cursor"]);
const CURSOR_CONTEXT_ENGINE_HOST_CAPABILITIES = [
  "bootstrap",
  "assemble-before-prompt",
  "after-turn",
  "maintain",
  "compact",
] as const satisfies readonly ContextEngineHostCapability[];

/**
 * Creates the Cursor SDK harness used for attempts, side questions,
 * compaction, reset, and disposal.
 */
type CursorHarnessLogger = {
  warn?: (message: string) => void;
  debug?: (message: string) => void;
};

export function createCursorAgentHarness(options: {
  id?: string;
  label?: string;
  providerIds?: Iterable<string>;
  pluginConfig?: unknown;
  resolvePluginConfig?: () => unknown;
  resolveConfig?: () => OpenClawConfig | undefined;
  bindingStore: CursorBindingStore;
  logger?: CursorHarnessLogger;
}): AgentHarness {
  const providerIds = new Set(
    [...(options.providerIds ?? DEFAULT_CURSOR_HARNESS_PROVIDER_IDS)].map((id) =>
      id.trim().toLowerCase(),
    ),
  );
  const tracked = new Map<
    string,
    { agentId: string; compatKey: string; runtime: "local" | "cloud" }
  >();
  let disposed = false;
  const inFlight = new Set<Promise<unknown>>();

  const track = <T>(promise: Promise<T>): Promise<T> => {
    inFlight.add(promise);
    return promise.finally(() => {
      inFlight.delete(promise);
    });
  };

  const harness: AgentHarness = {
    id: options.id ?? "cursor",
    label: options.label ?? "Cursor agent harness",
    contextEngineHostCapabilities: CURSOR_CONTEXT_ENGINE_HOST_CAPABILITIES,
    // Cursor often replies as plain text; message_tool_only would stay private.
    deliveryDefaults: {
      sourceVisibleReplies: "automatic",
    },
    supports: (ctx) => {
      const provider = ctx.provider.trim().toLowerCase();
      if (providerIds.has(provider)) {
        return { supported: true, priority: 100 };
      }
      return {
        supported: false,
        reason: `provider is not one of: ${[...providerIds].toSorted().join(", ")}`,
      };
    },
    runAttempt: async (params: AgentHarnessAttemptParams): Promise<AgentHarnessAttemptResult> => {
      if (disposed) {
        throw new Error("[cursor] harness has been disposed; cannot start new attempts");
      }
      return track(
        (async () => {
          const { runCursorAttempt } = await import("./src/attempt.js");
          const openclawSessionId =
            typeof params.sessionId === "string" ? params.sessionId.trim() : "";
          return runCursorAttempt(params, {
            bindingStore: options.bindingStore,
            pluginConfig: options.resolvePluginConfig?.() ?? options.pluginConfig,
            resolvePluginConfig: options.resolvePluginConfig,
            logger: options.logger,
            onAgentEstablished: openclawSessionId
              ? async ({ agentId, compatKey, runtime, storeKey, sessionId }) => {
                  tracked.set(storeKey, { agentId, compatKey, runtime });
                  const identity = sessionBindingIdentity({
                    sessionId,
                    sessionKey: params.sessionKey,
                    agentId: params.agentId,
                    config: params.config,
                  });
                  await withCursorBindingLease(options.bindingStore, identity, async () => {
                    registerCursorBinding(options.bindingStore, storeKey, {
                      schemaVersion: 1,
                      agentId,
                      compatKey,
                      runtime,
                      sessionId,
                      updatedAt: Date.now(),
                    });
                  });
                }
              : undefined,
          });
        })(),
      );
    },
    runSideQuestion: async (
      params: AgentHarnessSideQuestionParams,
    ): Promise<AgentHarnessSideQuestionResult> => {
      if (disposed) {
        throw new Error("[cursor] harness has been disposed; cannot start side questions");
      }
      return track(
        (async () => {
          const { runCursorSideQuestion } = await import("./src/side-question.js");
          return runCursorSideQuestion(
            {
              question: params.question,
              workspaceDir: params.workspaceDir,
              agentDir: params.agentDir,
              agentId: params.agentId,
              provider: params.provider,
              model: params.model,
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              config: params.cfg,
            },
            {
              pluginConfig: options.resolvePluginConfig?.() ?? options.pluginConfig,
              resolvePluginConfig: options.resolvePluginConfig,
            },
          );
        })(),
      );
    },
    compact: async (
      params: AgentHarnessCompactParams,
    ): Promise<AgentHarnessCompactResult | undefined> => {
      if (disposed) {
        return {
          ok: false,
          compacted: false,
          reason: "harness-disposed",
          failure: { reason: "harness-disposed" },
        };
      }
      return track(
        (async () => {
          const { maybeCompactCursorSession } = await import("./src/compact.js");
          return maybeCompactCursorSession(
            {
              sessionId: params.sessionId,
              sessionFile: params.sessionFile,
              sessionKey: params.sessionKey,
              agentId: params.agentId,
              workspaceDir: params.workspaceDir,
              provider: params.provider,
              model: typeof params.model === "string" ? params.model : undefined,
              customInstructions: params.customInstructions,
              currentTokenCount: params.currentTokenCount,
              abortSignal: params.abortSignal,
              config: params.config,
              resolvedApiKey: params.resolvedApiKey,
              runId: params.runId,
              trigger: params.trigger,
            },
            {
              bindingStore: options.bindingStore,
              pluginConfig: options.resolvePluginConfig?.() ?? options.pluginConfig,
              resolvePluginConfig: options.resolvePluginConfig,
            },
          );
        })(),
      );
    },
    reset: async (params: AgentHarnessResetParams) => {
      const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
      if (!sessionId) {
        return;
      }
      const identity = sessionBindingIdentity({
        sessionId,
        sessionKey: typeof params.sessionKey === "string" ? params.sessionKey : undefined,
        agentId: typeof params.agentId === "string" ? params.agentId : undefined,
        config: options.resolveConfig?.(),
      });
      tracked.delete(sessionId);
      retireSessionGeneration(options.bindingStore, identity);
    },
    dispose: async () => {
      disposed = true;
      if (inFlight.size > 0) {
        await Promise.allSettled(inFlight);
      }
      tracked.clear();
    },
  };

  return harness;
}
