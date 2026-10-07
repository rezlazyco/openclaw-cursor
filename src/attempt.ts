/**
 * Cursor SDK turn executor for OpenClaw agent harness attempts.
 */
import { Agent, type SDKAgent } from "@cursor/sdk";
import {
  awaitAgentEndSideEffects,
  buildAgentHookContextChannelFields,
  clearActiveEmbeddedRun,
  resolveSessionAgentIds,
  runAgentEndSideEffects,
  runAgentHarnessAfterToolCallHook,
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
  setActiveEmbeddedRun,
  type AgentHarnessAttemptParams,
  type AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveCursorApiKey } from "./auth.js";
import { readCursorPluginConfig, type CursorPluginConfig } from "./config.js";
import { applyCursorSdkNetworkConfig } from "./sdk-network.js";
import { createCursorStreamBridge } from "./event-bridge.js";
import { toCursorSdkImages } from "./images.js";
import {
  buildCursorMcpServers,
  fingerprintCursorMcpServers,
} from "./mcp-bridge.js";
import {
  bindingStoreKey,
  computeCursorCompatKey,
  deleteCursorBinding,
  fingerprintSecret,
  lookupSessionBinding,
  sessionBindingIdentity,
  type CursorBindingStore,
} from "./session-binding.js";
import { trackCursorActiveRun } from "./conversation-control.js";
import {
  buildCursorFailure,
  failureKindForCaught,
  logCursorFailure,
  promptErrorFromCursorFailure,
  type CursorPluginLogger,
} from "./cursor-failure.js";
import { createCursorAttemptResult, createPromptError } from "./result.js";
import {
  attachCursorMirrorIdentity,
  dualWriteCursorTranscriptBestEffort,
} from "./transcript-mirror.js";
import { buildBackgroundJobCustomTools } from "./background-jobs-tool.js";
import { mergeCursorCustomTools } from "./custom-tools-merge.js";
import {
  buildCursorToolBridge,
  type CursorToolTelemetry,
} from "./tool-bridge.js";
import type { McpServerConfig as CursorMcpServerConfig, SDKCustomTool } from "@cursor/sdk";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";

export type CursorAttemptDeps = {
  bindingStore?: CursorBindingStore;
  pluginConfig?: unknown;
  resolvePluginConfig?: () => unknown;
  logger?: CursorPluginLogger;
  onAgentEstablished?: (info: {
    agentId: string;
    compatKey: string;
    runtime: "local" | "cloud";
    storeKey: string;
    sessionId: string;
  }) => void | Promise<void>;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function resolveWorkspaceDir(params: AgentHarnessAttemptParams): string {
  return (
    readString(params.cwd) ??
    readString(params.workspaceDir) ??
    process.cwd()
  );
}

function resolveModelId(params: AgentHarnessAttemptParams): string {
  const fromModel =
    params.model && typeof params.model === "object"
      ? readString((params.model as { id?: unknown }).id)
      : undefined;
  return fromModel ?? readString(params.modelId) ?? "composer-2.5";
}

async function disposeAgent(agent: SDKAgent | undefined): Promise<void> {
  if (!agent) {
    return;
  }
  try {
    await agent[Symbol.asyncDispose]();
  } catch {
    // Best-effort cleanup.
  }
}

async function createOrResumeAgent(params: {
  apiKey: string;
  modelId: string;
  workspaceDir: string;
  pluginConfig: CursorPluginConfig;
  resumeAgentId?: string;
  customTools?: Record<string, SDKCustomTool>;
  mcpServers?: Record<string, CursorMcpServerConfig>;
}): Promise<SDKAgent> {
  const model = { id: params.modelId };
  const shared = {
    apiKey: params.apiKey,
    model,
    ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
  };

  if (params.resumeAgentId) {
    return await Agent.resume(params.resumeAgentId, {
      ...shared,
      ...(params.pluginConfig.runtime === "local"
        ? {
            local: {
              cwd: params.workspaceDir,
              settingSources: params.pluginConfig.local.settingSources,
              ...(params.pluginConfig.local.sandboxEnabled
                ? { sandboxOptions: { enabled: true } }
                : {}),
              ...(params.pluginConfig.local.autoReview ? { autoReview: true } : {}),
              ...(params.customTools ? { customTools: params.customTools } : {}),
            },
          }
        : {}),
    });
  }

  if (params.pluginConfig.runtime === "cloud") {
    const repoUrl = params.pluginConfig.cloud.repoUrl;
    if (!repoUrl) {
      throw createPromptError(
        "cursor_cloud_config",
        "Cursor cloud runtime requires plugins.entries.cursor.config.cloud.repoUrl",
      );
    }
    return await Agent.create({
      ...shared,
      cloud: {
        repos: [
          {
            url: repoUrl,
            ...(params.pluginConfig.cloud.startingRef
              ? { startingRef: params.pluginConfig.cloud.startingRef }
              : {}),
          },
        ],
        autoCreatePR: params.pluginConfig.cloud.autoCreatePR,
        skipReviewerRequest: params.pluginConfig.cloud.skipReviewerRequest,
      },
    });
  }

  return await Agent.create({
    ...shared,
    local: {
      cwd: params.workspaceDir,
      settingSources: params.pluginConfig.local.settingSources,
      ...(params.pluginConfig.local.sandboxEnabled
        ? { sandboxOptions: { enabled: true } }
        : {}),
      ...(params.pluginConfig.local.autoReview ? { autoReview: true } : {}),
      ...(params.customTools ? { customTools: params.customTools } : {}),
    },
  });
}

function clearStoredBinding(params: {
  bindingStore?: CursorBindingStore;
  storeKey?: string;
  openclawSessionId?: string;
}): void {
  if (!params.bindingStore) {
    return;
  }
  if (params.storeKey) {
    deleteCursorBinding(params.bindingStore, params.storeKey);
  }
  if (params.openclawSessionId) {
    deleteCursorBinding(params.bindingStore, params.openclawSessionId);
  }
}

/**
 * Prefer resume when a binding exists; on any resume failure, drop the binding
 * and create a fresh agent in the same turn (Codex-style recovery).
 */
async function createOrResumeAgentWithRecovery(params: {
  apiKey: string;
  modelId: string;
  workspaceDir: string;
  pluginConfig: CursorPluginConfig;
  resumeAgentId?: string;
  customTools?: Record<string, SDKCustomTool>;
  mcpServers?: Record<string, CursorMcpServerConfig>;
  bindingStore?: CursorBindingStore;
  storeKey?: string;
  openclawSessionId?: string;
  onResumeFallback?: (error: unknown, resumeAgentId: string) => void;
}): Promise<SDKAgent> {
  const { resumeAgentId, onResumeFallback, bindingStore, storeKey, openclawSessionId, ...createParams } =
    params;
  if (!resumeAgentId) {
    return await createOrResumeAgent(createParams);
  }

  try {
    return await createOrResumeAgent({ ...createParams, resumeAgentId });
  } catch (error) {
    onResumeFallback?.(error, resumeAgentId);
    clearStoredBinding({ bindingStore, storeKey, openclawSessionId });
    return await createOrResumeAgent(createParams);
  }
}

/**
 * Runs one OpenClaw attempt through a Cursor SDK agent.
 */
export async function runCursorAttempt(
  params: AgentHarnessAttemptParams,
  deps: CursorAttemptDeps = {},
): Promise<AgentHarnessAttemptResult> {
  const pluginConfig = readCursorPluginConfig(
    deps.resolvePluginConfig?.() ?? deps.pluginConfig,
  );
  applyCursorSdkNetworkConfig(pluginConfig);
  const workspaceDir = resolveWorkspaceDir(params);
  const modelId = resolveModelId(params);
  const provider = readString(params.provider)?.toLowerCase() ?? "cursor";
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: readString(params.sessionKey),
    config: params.config,
    agentId: readString(params.agentId),
  });
  const hookContext = {
    runId: params.runId,
    jobId: params.jobId,
    agentId: sessionAgentId,
    sessionKey: readString(params.sessionKey) ?? params.sessionId,
    sessionId: params.sessionId,
    workspaceDir,
    modelProviderId: provider,
    modelId,
    trigger: params.trigger,
    ...(params.config ? { config: params.config } : {}),
    ...buildAgentHookContextChannelFields(params),
  };

  if (params.abortSignal?.aborted) {
    return createCursorAttemptResult({
      attempt: params,
      aborted: true,
      externalAbort: true,
    });
  }

  let auth;
  try {
    auth = resolveCursorApiKey({
      pluginConfig,
      resolvedApiKey: readString(params.resolvedApiKey),
    });
  } catch (error) {
    return createCursorAttemptResult({
      attempt: params,
      promptError: createPromptError("auth_missing", toError(error).message, error),
    });
  }

  const userPromptText =
    typeof params.transcriptPrompt === "string" && params.transcriptPrompt.trim()
      ? params.transcriptPrompt
      : params.prompt;

  const apiKeyFingerprint = await fingerprintSecret(auth.apiKey);
  const mcpServers = buildCursorMcpServers({
    config: params.config,
    agentId: sessionAgentId,
  });
  const mcpFingerprint = fingerprintCursorMcpServers(mcpServers);
  const compatKey = computeCursorCompatKey({
    provider,
    modelId,
    workspaceDir,
    runtime: pluginConfig.runtime,
    apiKeyFingerprint,
    cloudRepoUrl: pluginConfig.cloud.repoUrl,
    mcpFingerprint,
  });

  const openclawSessionId = readString(params.sessionId);
  const bindingIdentity =
    openclawSessionId
      ? sessionBindingIdentity({
          sessionId: openclawSessionId,
          sessionKey: readString(params.sessionKey),
          agentId: sessionAgentId,
          config: params.config,
        })
      : undefined;
  const storeKey = bindingIdentity ? bindingStoreKey(bindingIdentity) : undefined;
  const stored =
    bindingIdentity && deps.bindingStore
      ? lookupSessionBinding(deps.bindingStore, bindingIdentity)
      : undefined;
  const resumeAgentId =
    stored &&
    stored.schemaVersion === 1 &&
    stored.compatKey === compatKey &&
    stored.runtime === pluginConfig.runtime
      ? stored.agentId
      : undefined;

  const toolBridge =
    pluginConfig.runtime === "local"
      ? await buildCursorToolBridge({
          params,
          excludeToolNames: pluginConfig.cursorDynamicToolsExclude,
          agentId: sessionAgentId,
          onToolCompleted: ({ toolName, toolCallId, args, result, error, startedAt }) =>
            runAgentHarnessAfterToolCallHook({
              toolName,
              toolCallId,
              runId: params.runId,
              agentId: sessionAgentId,
              sessionId: params.sessionId,
              sessionKey: readString(params.sessionKey) ?? params.sessionId,
              startArgs: args,
              ...(result !== undefined ? { result } : {}),
              ...(error ? { error } : {}),
              startedAt,
            }),
        })
      : undefined;
  const backgroundTools =
    pluginConfig.runtime === "local" && pluginConfig.local.backgroundJobs.enabled
      ? buildBackgroundJobCustomTools({
          pluginConfig,
          workspaceDir,
          modelId,
          bridgeParams: params,
        })
      : undefined;
  const customTools = mergeCursorCustomTools(toolBridge?.customTools, backgroundTools);
  const toolTelemetry: CursorToolTelemetry | undefined = toolBridge?.telemetry;

  let agent: SDKAgent | undefined;
  let activeRun:
    | {
        cancel?: () => Promise<void>;
        supports?: (op: "stream" | "wait" | "cancel" | "conversation") => boolean;
      }
    | undefined;
  let aborted = false;
  let externalAbort = false;
  let timedOut = false;
  let completed = false;
  let promptError: unknown;
  let cursorAgentId: string | undefined = resumeAgentId;
  let runUsage:
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        reasoningTokens?: number;
        total?: number;
      }
    | undefined;
  const bridge = createCursorStreamBridge({
    onPartialReply: params.onPartialReply
      ? async (payload) => {
          await params.onPartialReply?.(payload as never);
        }
      : undefined,
    onAgentEvent: params.onAgentEvent
      ? async (event) => {
          await params.onAgentEvent?.(event as never);
        }
      : undefined,
  });

  const abortExplicitly = () => {
    aborted = true;
    externalAbort = true;
    void (async () => {
      try {
        if (activeRun?.supports?.("cancel")) {
          await activeRun.cancel?.();
        }
      } catch {
        // Best-effort cancel.
      }
    })();
  };
  const abortHandler = () => {
    abortExplicitly();
  };
  params.abortSignal?.addEventListener("abort", abortHandler, { once: true });

  // Must be the same object reference for setActiveEmbeddedRun / clearActiveEmbeddedRun.
  // A stub without abort() leaves a zombie run; the next Telegram turn then crashes with
  // "handle.abort is not a function".
  const embeddedRunHandle = {
    kind: "embedded" as const,
    runId: params.runId,
    queueMessage: async () => {
      throw new Error(
        "Cursor harness does not support mid-run message injection; wait for the turn to finish or use /new",
      );
    },
    isStreaming: () => Boolean(activeRun) && !aborted && !timedOut && !completed,
    isStopped: () => completed || aborted || timedOut || !activeRun,
    isAbortable: () => !completed,
    isCompacting: () => false,
    cancel: () => abortExplicitly(),
    abort: () => abortExplicitly(),
  };
  setActiveEmbeddedRun(
    params.sessionId,
    embeddedRunHandle as never,
    params.sessionKey,
    params.sessionFile,
  );

  try {
    const promptImages = toCursorSdkImages(
      Array.isArray(params.images) ? (params.images as unknown[]) : undefined,
    );
    runAgentHarnessLlmInputHook({
      event: {
        runId: params.runId,
        sessionId: params.sessionId,
        provider,
        model: modelId,
        prompt: params.prompt,
        historyMessages: [],
        imagesCount: promptImages.length,
      },
      ctx: hookContext,
    });

    agent = await createOrResumeAgentWithRecovery({
      apiKey: auth.apiKey,
      modelId,
      workspaceDir,
      pluginConfig,
      resumeAgentId,
      customTools,
      mcpServers,
      bindingStore: deps.bindingStore,
      storeKey,
      openclawSessionId,
    });
    cursorAgentId = agent.agentId;
    await deps.onAgentEstablished?.({
      agentId: agent.agentId,
      compatKey,
      runtime: pluginConfig.runtime,
      storeKey: storeKey ?? openclawSessionId ?? params.sessionId,
      sessionId: openclawSessionId ?? params.sessionId,
    });

    const promptText = params.prompt;
    const sendMessage =
      promptImages.length > 0 ? { text: promptText, images: promptImages } : promptText;

    // Inline mcpServers are not persisted across resume; pass on every send too.
    const run = await agent.send(sendMessage, {
      ...(mcpServers ? { mcpServers } : {}),
      ...(pluginConfig.runtime === "local" && customTools
        ? { local: { customTools } }
        : {}),
    });
    activeRun = run;
    const untrackActive = trackCursorActiveRun(storeKey ?? params.sessionId, {
      runId: run.id,
      agentId: agent.agentId,
      cancel: () => run.cancel(),
      supportsCancel: run.supports("cancel"),
      startedAt: Date.now(),
    });

    const timeoutMs =
      typeof params.timeoutMs === "number" && params.timeoutMs > 0
        ? params.timeoutMs
        : undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise =
      timeoutMs !== undefined
        ? new Promise<"timeout">((resolve) => {
            timeoutId = setTimeout(() => resolve("timeout"), timeoutMs);
          })
        : undefined;

    try {
      const streamPromise = (async () => {
        for await (const event of run.stream()) {
          if (params.abortSignal?.aborted) {
            if (run.supports("cancel")) {
              await run.cancel();
            }
            break;
          }
          await bridge.handleMessage(event);
        }
        return await run.wait();
      })();

      const raced = timeoutPromise
        ? await Promise.race([streamPromise, timeoutPromise])
        : await streamPromise;

      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }

      if (raced === "timeout") {
        timedOut = true;
        if (run.supports("cancel")) {
          await run.cancel().catch(() => undefined);
        }
        promptError = createPromptError("timeout", `Cursor run timed out after ${timeoutMs}ms`);
      } else {
        const result = raced;
        if (result.usage) {
          runUsage = {
            input: result.usage.inputTokens,
            output: result.usage.outputTokens,
            cacheRead: result.usage.cacheReadTokens,
            cacheWrite: result.usage.cacheWriteTokens,
            reasoningTokens: result.usage.reasoningTokens,
            total: result.usage.totalTokens,
          };
        }
        if (result.status === "error") {
          const failure = buildCursorFailure({
            kind: "run_error",
            runResult: result,
            streamError: bridge.state.streamError,
            cursorAgentId,
            fallbackMessage: `Cursor run ${result.id} failed with status error`,
          });
          logCursorFailure(deps.logger, "attempt", failure);
          promptError = promptErrorFromCursorFailure(
            failure,
            bridge.state.streamError ?? result.error,
          );
        } else if (result.status === "cancelled") {
          aborted = true;
        }
        if (bridge.state.streamError && !promptError) {
          const failure = buildCursorFailure({
            kind: "run_error",
            streamError: bridge.state.streamError,
            cursorAgentId,
          });
          logCursorFailure(deps.logger, "attempt", failure);
          promptError = promptErrorFromCursorFailure(failure, bridge.state.streamError);
        }
      }
    } finally {
      untrackActive();
      completed = true;
    }
  } catch (error) {
    completed = true;
    const failure = buildCursorFailure({
      kind: failureKindForCaught(error),
      caught: error,
      cursorAgentId,
    });
    logCursorFailure(deps.logger, "attempt", failure);
    promptError = promptErrorFromCursorFailure(failure, error);
  } finally {
    params.abortSignal?.removeEventListener("abort", abortHandler);
    clearActiveEmbeddedRun(
      params.sessionId,
      embeddedRunHandle as never,
      params.sessionKey,
      params.sessionFile,
    );
    // Keep the agent process handles disposed per attempt; resume uses Agent.resume(agentId).
    await disposeAgent(agent);
  }

  let assistantTexts = bridge.finalizeAssistantTexts();
  const mergedToolMetas = [
    ...(toolTelemetry?.toolMetas ?? []),
    ...bridge.state.toolMetas.filter(
      (meta) =>
        !(toolTelemetry?.toolMetas ?? []).some((existing) => existing.toolName === meta.toolName),
    ),
  ];

  const turnId = `${cursorAgentId ?? params.sessionId}:${params.runId ?? Date.now()}`;
  const messagesSnapshot: AgentMessage[] = [
    attachCursorMirrorIdentity(
      {
        role: "user",
        content: userPromptText,
        timestamp: Date.now(),
      } as AgentMessage,
      `${turnId}:prompt`,
    ),
    ...(toolTelemetry?.toolMessages ?? []).map((message, index) =>
      attachCursorMirrorIdentity(message, `${turnId}:tool:${index}`),
    ),
    ...assistantTexts.map((text, index) =>
      attachCursorMirrorIdentity(
        {
          role: "assistant",
          content: [{ type: "text", text }],
          timestamp: Date.now(),
        } as AgentMessage,
        `${turnId}:assistant:${index}`,
      ),
    ),
  ];

  if (params.sessionFile && params.sessionId) {
    await dualWriteCursorTranscriptBestEffort({
      sessionFile: params.sessionFile,
      sessionId: params.sessionId,
      sessionKey: readString(params.sessionKey),
      agentId: sessionAgentId,
      messages: messagesSnapshot,
      idempotencyScope: cursorAgentId ? `cursor:${cursorAgentId}` : `cursor:${params.sessionId}`,
      config: params.config,
    });
  }

  const attemptResult = createCursorAttemptResult({
    attempt: params,
    aborted,
    externalAbort,
    timedOut,
    promptError,
    assistantTexts,
    toolMetas: mergedToolMetas,
    messagesSnapshot,
    cursorAgentId,
    hadPotentialSideEffects: mergedToolMetas.length > 0,
    telemetry: toolTelemetry,
    attemptUsage: runUsage,
  });

  runAgentHarnessLlmOutputHook({
    event: {
      runId: params.runId,
      sessionId: params.sessionId,
      provider,
      model: modelId,
      assistantTexts: attemptResult.assistantTexts,
      ...(attemptResult.lastAssistant ? { lastAssistant: attemptResult.lastAssistant } : {}),
      ...(runUsage ? { usage: runUsage } : {}),
      ...(params.runtimePlan?.observability?.harnessId
        ? { harnessId: params.runtimePlan.observability.harnessId }
        : {}),
    },
    ctx: hookContext,
  });

  const endPayload = {
    event: {
      success: !attemptResult.aborted && !attemptResult.promptError && !attemptResult.timedOut,
      ...(attemptResult.promptError
        ? { error: toError(attemptResult.promptError).message }
        : {}),
      durationMs: 0,
      messages: attemptResult.messagesSnapshot,
    },
    ctx: hookContext,
  };
  if (params.trigger === "cron" || params.trigger === "heartbeat") {
    await awaitAgentEndSideEffects(endPayload as never);
  } else {
    runAgentEndSideEffects(endPayload as never);
  }

  return attemptResult;
}
