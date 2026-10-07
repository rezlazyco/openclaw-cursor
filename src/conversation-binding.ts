/**
 * Channel conversation binding: inbound_claim turns via Cursor SDK agents.
 */
import { Agent, type SDKAgent, type SDKCustomTool } from "@cursor/sdk";
import { resolveCursorApiKey } from "./auth.js";
import { readCursorPluginConfig, type CursorPluginConfig } from "./config.js";
import {
  buildConversationToolBridgeParams,
  extractInboundClaimImages,
  type CursorInboundClaimContext,
  type CursorInboundClaimEvent,
} from "./conversation-inbound.js";
import {
  readCursorConversationBindingData,
  readCursorConversationBindingDataRecord,
  type CursorConversationBindingData,
} from "./conversation-binding-data.js";
import { createCursorStreamBridge } from "./event-bridge.js";
import { buildCursorMcpServers } from "./mcp-bridge.js";
import {
  bindingStoreKey,
  conversationBindingIdentity,
  deleteCursorBinding,
  lookupCursorBinding,
  registerCursorBinding,
  type CursorBindingStore,
  type StoredCursorBinding,
} from "./session-binding.js";
import { withCursorBindingLease } from "./binding-store.js";
import { trackCursorActiveRun } from "./conversation-control.js";
import { buildBackgroundJobCustomTools } from "./background-jobs-tool.js";
import { mergeCursorCustomTools } from "./custom-tools-merge.js";
import { buildCursorToolBridge } from "./tool-bridge.js";

export type {
  CursorInboundClaimContext,
  CursorInboundClaimEvent,
} from "./conversation-inbound.js";

export type CursorInboundClaimResult = {
  handled: boolean;
  reply?: { text?: string };
};

export type CursorConversationBindingResolvedEvent = {
  status: "approved" | "denied";
  request: { data?: Record<string, unknown> };
};

const turnQueues = new Map<string, Promise<unknown>>();

async function enqueueBoundTurn<T>(bindingId: string, task: () => Promise<T>): Promise<T> {
  const previous = turnQueues.get(bindingId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => gate);
  turnQueues.set(bindingId, next);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (turnQueues.get(bindingId) === next) {
      turnQueues.delete(bindingId);
    }
  }
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

function resolvePrompt(event: CursorInboundClaimEvent): string {
  return event.bodyForAgent?.trim() || event.content?.trim() || event.body?.trim() || "";
}

function buildLocalAgentOptions(
  pluginConfig: CursorPluginConfig,
  workspaceDir: string,
  customTools?: Record<string, SDKCustomTool>,
) {
  return {
    cwd: workspaceDir,
    settingSources: pluginConfig.local.settingSources,
    ...(pluginConfig.local.sandboxEnabled ? { sandboxOptions: { enabled: true } } : {}),
    ...(pluginConfig.local.autoReview ? { autoReview: true } : {}),
    ...(customTools ? { customTools } : {}),
  };
}

async function ensureConversationAgent(params: {
  data: CursorConversationBindingData;
  bindingStore: CursorBindingStore;
  pluginConfig: unknown;
  config?: unknown;
  sessionKey?: string;
  customTools?: Record<string, SDKCustomTool>;
}): Promise<{ agent: SDKAgent; binding: StoredCursorBinding; created: boolean }> {
  const pluginConfig = readCursorPluginConfig(params.pluginConfig);
  const auth = resolveCursorApiKey({ pluginConfig });
  const storeKey = bindingStoreKey(conversationBindingIdentity(params.data.bindingId));
  const existing = lookupCursorBinding(params.bindingStore, storeKey);

  const requestedAgentId =
    params.data.start?.cursorAgentId?.trim() ||
    params.data.source?.cursorAgentId?.trim() ||
    existing?.agentId;
  const modelId = params.data.start?.model?.trim() || "composer-2.5";
  const workspaceDir = params.data.workspaceDir || process.cwd();
  const mcpServers = buildCursorMcpServers({
    config: params.config,
    agentId: params.data.agentId,
  });
  const localOptions =
    pluginConfig.runtime === "local"
      ? { local: buildLocalAgentOptions(pluginConfig, workspaceDir, params.customTools) }
      : {};

  let agent: SDKAgent;
  let created = false;
  if (requestedAgentId && existing?.agentId === requestedAgentId) {
    agent = await Agent.resume(requestedAgentId, {
      apiKey: auth.apiKey,
      model: { id: modelId },
      ...(mcpServers ? { mcpServers } : {}),
      ...localOptions,
    });
  } else if (requestedAgentId && !existing) {
    try {
      agent = await Agent.resume(requestedAgentId, {
        apiKey: auth.apiKey,
        model: { id: modelId },
        ...(mcpServers ? { mcpServers } : {}),
        ...localOptions,
      });
    } catch {
      agent = await createFreshAgent({
        apiKey: auth.apiKey,
        modelId,
        workspaceDir,
        pluginConfig,
        mcpServers,
        customTools: params.customTools,
      });
      created = true;
    }
  } else if (existing?.agentId) {
    agent = await Agent.resume(existing.agentId, {
      apiKey: auth.apiKey,
      model: { id: modelId },
      ...(mcpServers ? { mcpServers } : {}),
      ...localOptions,
    });
  } else {
    agent = await createFreshAgent({
      apiKey: auth.apiKey,
      modelId,
      workspaceDir,
      pluginConfig,
      mcpServers,
      customTools: params.customTools,
    });
    created = true;
  }

  const binding: StoredCursorBinding = {
    schemaVersion: 1,
    agentId: agent.agentId,
    compatKey: `conversation=${params.data.bindingId}|model=${modelId}|cwd=${workspaceDir}|runtime=${pluginConfig.runtime}`,
    runtime: pluginConfig.runtime,
    updatedAt: Date.now(),
  };
  await withCursorBindingLease(
    params.bindingStore,
    conversationBindingIdentity(params.data.bindingId),
    async () => {
      registerCursorBinding(params.bindingStore, storeKey, binding);
    },
  );
  return { agent, binding, created };
}

async function createFreshAgent(params: {
  apiKey: string;
  modelId: string;
  workspaceDir: string;
  pluginConfig: ReturnType<typeof readCursorPluginConfig>;
  mcpServers?: ReturnType<typeof buildCursorMcpServers>;
  customTools?: Record<string, SDKCustomTool>;
}): Promise<SDKAgent> {
  const shared = {
    apiKey: params.apiKey,
    model: { id: params.modelId },
    ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
  };
  if (params.pluginConfig.runtime === "cloud") {
    const repoUrl = params.pluginConfig.cloud.repoUrl;
    if (!repoUrl) {
      throw new Error(
        "Cursor cloud runtime requires plugins.entries.cursor.config.cloud.repoUrl for conversation binds",
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
    local: buildLocalAgentOptions(
      params.pluginConfig,
      params.workspaceDir,
      params.customTools,
    ),
  });
}

async function runBoundTurn(params: {
  data: CursorConversationBindingData;
  prompt: string;
  event: CursorInboundClaimEvent;
  ctx: CursorInboundClaimContext;
  bindingStore: CursorBindingStore;
  pluginConfig?: unknown;
  config?: unknown;
  sessionKey?: string;
}): Promise<{ text?: string; messagingOnly?: boolean }> {
  const pluginConfig = readCursorPluginConfig(params.pluginConfig);
  let customTools: Record<string, SDKCustomTool> | undefined;
  let toolBridge:
    | Awaited<ReturnType<typeof buildCursorToolBridge>>
    | undefined;
  if (pluginConfig.runtime === "local") {
    const bridgeParams = buildConversationToolBridgeParams({
      event: params.event,
      ctx: params.ctx,
      data: params.data,
      config: params.config,
    });
    toolBridge = await buildCursorToolBridge({
      params: bridgeParams,
      excludeToolNames: pluginConfig.cursorDynamicToolsExclude,
      agentId: params.data.agentId,
    });
    const modelId =
      (typeof params.data.start?.model === "string" && params.data.start.model.trim()
        ? params.data.start.model.trim()
        : undefined) ?? "composer-2.5";
    const workspaceDir = params.data.workspaceDir || process.cwd();
    const backgroundTools =
      pluginConfig.local.backgroundJobs.enabled
        ? buildBackgroundJobCustomTools({
            pluginConfig,
            workspaceDir,
            modelId,
            bridgeParams,
          })
        : undefined;
    customTools = mergeCursorCustomTools(toolBridge?.customTools, backgroundTools);
  }

  const ensured = await ensureConversationAgent({
    data: params.data,
    bindingStore: params.bindingStore,
    pluginConfig: params.pluginConfig,
    config: params.config,
    sessionKey: params.sessionKey,
    customTools,
  });
  const bridge = createCursorStreamBridge();
  const storeKey = bindingStoreKey(conversationBindingIdentity(params.data.bindingId));
  const images = extractInboundClaimImages(params.event);
  const sendPayload =
    images.length > 0 ? { text: params.prompt, images } : params.prompt;
  const mcpServers = buildCursorMcpServers({
    config: params.config,
    agentId: params.data.agentId,
  });
  try {
    const run = await ensured.agent.send(sendPayload, {
      ...(mcpServers ? { mcpServers } : {}),
      ...(pluginConfig.runtime === "local" && customTools
        ? { local: { customTools } }
        : {}),
    });
    const untrack = trackCursorActiveRun(storeKey, {
      runId: run.id,
      agentId: ensured.agent.agentId,
      cancel: () => run.cancel(),
      supportsCancel: run.supports("cancel"),
      startedAt: Date.now(),
    });
    try {
      for await (const event of run.stream()) {
        await bridge.handleMessage(event);
      }
      const result = await run.wait();
      if (result.status === "error") {
        throw new Error(`Cursor bound turn failed (run ${run.id})`);
      }
      const texts = bridge.finalizeAssistantTexts();
      const assistantText = texts.join("\n").trim();
      const messagingOnly =
        toolBridge?.telemetry.didSendViaMessagingTool === true && !assistantText;
      if (messagingOnly) {
        return { messagingOnly: true };
      }
      return {
        text: assistantText || "Cursor completed without a text reply.",
      };
    } finally {
      untrack();
    }
  } finally {
    await disposeAgent(ensured.agent);
  }
}

/**
 * Handles inbound channel messages for a Cursor-owned conversation binding.
 * Returns undefined to decline (host falls through to normal agent routing).
 */
export async function handleCursorConversationInboundClaim(
  event: CursorInboundClaimEvent,
  ctx: CursorInboundClaimContext,
  options: {
    bindingStore: CursorBindingStore;
    pluginConfig?: unknown;
    resolvePluginConfig?: () => unknown;
    config?: unknown;
  },
): Promise<CursorInboundClaimResult | undefined> {
  const data = readCursorConversationBindingData(ctx.pluginBinding);
  if (!data) {
    return undefined;
  }
  if (event.commandAuthorized !== true) {
    return { handled: true };
  }
  const prompt = resolvePrompt(event);
  if (!prompt) {
    return { handled: true };
  }

  try {
    const result = await enqueueBoundTurn(data.bindingId, () =>
      runBoundTurn({
        data,
        prompt,
        event,
        ctx,
        bindingStore: options.bindingStore,
        pluginConfig: options.resolvePluginConfig?.() ?? options.pluginConfig,
        config: options.config,
        sessionKey: event.sessionKey ?? ctx.sessionKey,
      }),
    );
    if (result.messagingOnly) {
      return { handled: true };
    }
    return { handled: true, reply: { text: result.text } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      handled: true,
      reply: { text: `Cursor conversation turn failed: ${message}` },
    };
  }
}

/** Clears conversation-scoped plugin state when a bind request is denied. */
export async function handleCursorConversationBindingResolved(
  event: CursorConversationBindingResolvedEvent,
  options: { bindingStore: CursorBindingStore },
): Promise<void> {
  if (event.status !== "denied") {
    return;
  }
  const data = readCursorConversationBindingDataRecord(event.request.data ?? {});
  if (!data) {
    return;
  }
  deleteCursorBinding(options.bindingStore, bindingStoreKey(conversationBindingIdentity(data.bindingId)));
}
