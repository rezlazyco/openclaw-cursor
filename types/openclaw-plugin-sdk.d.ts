/**
 * Ambient types for `openclaw/plugin-sdk/*` imports in this repo.
 * At runtime the host OpenClaw install provides the real SDK; stubs keep
 * `npm run typecheck` without pinning types to a specific published OpenClaw build.
 */

declare module "openclaw/plugin-sdk/plugin-entry" {
  export type ProviderRuntimeModel = Record<string, unknown>;
  export type OpenClawPluginToolContext = {
    sessionId?: string;
    sessionKey?: string;
    agentId?: string;
    workspaceDir?: string;
  };
  export function definePluginEntry(options: {
    id: string;
    name: string;
    description?: string;
    register: (api: any) => void;
  }): unknown;
}

declare module "openclaw/plugin-sdk/config-contracts" {
  export type OpenClawConfig = Record<string, unknown>;
}

declare module "openclaw/plugin-sdk/plugin-config-runtime" {
  export function resolveLivePluginConfigObject(
    resolveConfig: () => unknown,
    pluginId: string,
    fallback: Record<string, unknown>,
  ): Record<string, unknown> | undefined;
  export function resolvePluginConfigObject(
    config: unknown,
    pluginId: string,
  ): unknown;
}

declare module "openclaw/plugin-sdk/core" {
  export function createSubsystemLogger(name: string): {
    warn?: (message: string) => void;
    info?: (message: string) => void;
    debug?: (message: string) => void;
  };
  export function jsonResult(value: unknown): { content: Array<{ type: string; text: string }> };
  export function readStringParam(
    params: Record<string, unknown>,
    key: string,
    options?: { required?: boolean; label?: string },
  ): string | undefined;
  export type AnyAgentTool = Record<string, unknown>;
  export type PluginRuntime = Record<string, unknown>;
}

declare module "openclaw/plugin-sdk/provider-auth-api-key" {
  export function createProviderApiKeyAuthMethod(options: Record<string, unknown>): unknown;
}

declare module "openclaw/plugin-sdk/provider-model-shared" {
  export type ModelDefinitionConfig = Record<string, unknown> & {
    id: string;
    name: string;
    api?: string;
    reasoning?: boolean;
    input?: Array<"text" | "image" | "video" | "audio">;
    cost?: Record<string, number>;
    contextWindow?: number;
    maxTokens?: number;
    compat?: Record<string, unknown>;
  };
  export type ModelProviderConfig = {
    baseUrl: string;
    apiKey: string;
    auth: string;
    api: string;
    models: ModelDefinitionConfig[];
  };
  export type ProviderPlugin = Record<string, unknown> & {
    id: string;
    label: string;
  };
  export function normalizeModelCompat(model: Record<string, unknown>): Record<string, unknown>;
}

declare module "openclaw/plugin-sdk/provider-catalog-shared" {
  export type ProviderCatalogContext = {
    env?: NodeJS.ProcessEnv;
    config: {
      plugins?: {
        entries?: Record<string, { config?: unknown } | undefined>;
      };
    };
  };
}

declare module "openclaw/plugin-sdk/agent-harness-runtime" {
  export type AgentMessage = {
    role?: string;
    content?: unknown;
    timestamp?: number;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    idempotencyKey?: string;
    __openclaw?: Record<string, unknown>;
    [key: string]: unknown;
  };
  export type AnyAgentTool = {
    name?: string;
    description?: string;
    parameters?: unknown;
    inputSchema?: unknown;
    schema?: unknown;
    execute?: (...args: any[]) => any;
  };
  export type ContextEngineHostCapability = string;
  export type AgentHarnessAttemptParams = {
    sessionId: string;
    sessionKey?: string;
    sandboxSessionKey?: string;
    sessionFile: string;
    agentId?: string;
    runId?: string;
    jobId?: string;
    provider: string;
    modelId: string;
    model?: { id?: string; input?: string[] } | string;
    prompt: string;
    transcriptPrompt?: string;
    workspaceDir: string;
    cwd?: string;
    agentDir?: string;
    config?: unknown;
    timeoutMs: number;
    abortSignal?: AbortSignal;
    resolvedApiKey?: string;
    authProfileId?: string;
    disableTools?: boolean;
    toolsAllow?: string[];
    messageChannel?: string;
    messageProvider?: string;
    agentAccountId?: string;
    messageTo?: string;
    messageThreadId?: string | number;
    senderIsOwner?: boolean;
    trigger?: string;
    images?: unknown[];
    senderId?: string | null;
    senderName?: string | null;
    senderUsername?: string | null;
    groupId?: string | null;
    groupChannel?: string | null;
    groupSpace?: string | null;
    onPartialReply?: (payload: unknown) => void | Promise<void>;
    onAgentEvent?: (event: unknown) => void | Promise<void>;
    runtimePlan?: {
      observability?: {
        harnessId?: string;
        resolvedRef?: string;
      };
    };
  };
  export type AgentHarnessAttemptResult = Record<string, unknown> & {
    aborted: boolean;
    externalAbort: boolean;
    timedOut: boolean;
    idleTimedOut: boolean;
    timedOutDuringCompaction: boolean;
    promptError: unknown;
    promptErrorSource: "prompt" | "compaction" | "precheck" | "hook:before_agent_run" | null;
    sessionIdUsed: string;
    sessionFileUsed?: string;
    messagesSnapshot: AgentMessage[];
    assistantTexts: string[];
    toolMetas: Array<{ toolName: string; meta?: string }>;
    lastAssistant: unknown;
    currentAttemptAssistant?: unknown;
    didSendViaMessagingTool: boolean;
    messagingToolSentTexts: string[];
    messagingToolSentMediaUrls: string[];
    messagingToolSentTargets: unknown[];
    cloudCodeAssistFormatError: boolean;
    itemLifecycle: { activeCount: number; completedCount: number; startedCount: number };
    replayMetadata: Record<string, unknown>;
    yieldDetected?: boolean;
  };
  export type AgentHarnessSideQuestionParams = {
    cfg: unknown;
    agentDir: string;
    provider: string;
    model: string;
    question: string;
    sessionEntry?: unknown;
    sessionStore?: Record<string, unknown>;
    sessionKey?: string;
    storePath?: string;
    isNewSession?: boolean;
    sessionId: string;
    sessionFile: string;
    agentId?: string;
    workspaceDir?: string;
    authProfileId?: string;
    resolvedReasoningLevel?: string;
    [key: string]: unknown;
  };
  export type AgentHarnessSideQuestionResult = {
    text: string;
  };
  export type AgentHarnessCompactParams = {
    sessionId: string;
    sessionFile: string;
    sessionKey?: string;
    agentId?: string;
    workspaceDir?: string;
    provider?: string;
    model?: string | { id?: string };
    customInstructions?: string;
    currentTokenCount?: number;
    abortSignal?: AbortSignal;
    config?: unknown;
    resolvedApiKey?: string;
    runId?: string;
    trigger?: string;
    [key: string]: unknown;
  };
  export type AgentHarnessCompactResult = {
    ok: boolean;
    compacted: boolean;
    reason?: string;
    failure?: {
      reason?: string;
      status?: number;
      code?: string;
      rawError?: string;
    };
    result?: {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      tokensAfter?: number;
      details?: unknown;
      sessionId?: string;
      sessionFile?: string;
    };
  };
  export type AgentHarnessResetParams = {
    agentId?: string;
    sessionId?: string;
    sessionKey?: string;
    sessionFile?: string;
    reason?: string;
  };
  export type AgentHarnessSupportContext = {
    provider: string;
    modelId?: string;
    modelProvider?: Record<string, unknown>;
    requestedRuntime?: string;
    providerOwnerStatus?: string;
    providerOwnerPluginIds?: readonly string[];
  };
  export type AgentHarnessSupport =
    | { supported: true; priority?: number; reason?: string }
    | { supported: false; reason?: string };
  export type AgentHarness = {
    id: string;
    label: string;
    contextEngineHostCapabilities?: readonly ContextEngineHostCapability[];
    deliveryDefaults?: { sourceVisibleReplies?: "automatic" | "message_tool" };
    supports(ctx: AgentHarnessSupportContext): AgentHarnessSupport;
    runAttempt(params: AgentHarnessAttemptParams): Promise<AgentHarnessAttemptResult>;
    runSideQuestion?(
      params: AgentHarnessSideQuestionParams,
    ): Promise<AgentHarnessSideQuestionResult>;
    reset?(params: AgentHarnessResetParams): Promise<void> | void;
    dispose?(): Promise<void> | void;
    compact?(params: AgentHarnessCompactParams): Promise<AgentHarnessCompactResult | undefined>;
  };

  export function buildAgentHookContextChannelFields(params: unknown): Record<string, unknown>;
  export function resolveSessionAgentIds(params: {
    sessionKey?: string;
    config?: unknown;
    agentId?: string;
  }): { sessionAgentId: string };
  export function setActiveEmbeddedRun(sessionId: string, run: unknown, ...rest: unknown[]): void;
  export function clearActiveEmbeddedRun(sessionId: string, ...rest: unknown[]): void;
  export function runAgentHarnessLlmInputHook(params: unknown): void;
  export function runAgentHarnessLlmOutputHook(params: unknown): void;
  export function runAgentHarnessAfterToolCallHook(params: unknown): void;
  export function runAgentHarnessBeforeMessageWriteHook(params: {
    message: AgentMessage;
    agentId?: string;
    sessionKey?: string;
  }): AgentMessage | null | undefined;
  export function runAgentEndSideEffects(params: unknown, ...rest: unknown[]): void;
  export function awaitAgentEndSideEffects(params: unknown, ...rest: unknown[]): Promise<void>;
  export function isMessagingTool(toolName: string): boolean;
  export function isMessagingToolSendAction(
    toolName: string,
    args: Record<string, unknown>,
  ): boolean;
  export function extractMessagingToolSend(
    toolName: string,
    args: Record<string, unknown>,
    options?: unknown,
  ):
    | {
        tool?: string;
        provider?: string;
        accountId?: string;
        to?: string;
        threadId?: string | number;
      }
    | undefined;
  export function extractMessagingToolSendResult(
    pending: {
      tool?: string;
      provider?: string;
      accountId?: string;
      to?: string;
      threadId?: string | number;
    },
    result: unknown,
  ): {
    tool?: string;
    provider?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  export function isDeliveredMessagingToolResult(params: {
    toolName: string;
    args: Record<string, unknown>;
    result: unknown;
    isError?: boolean;
    hookResult?: unknown;
  }): boolean;
}

declare module "openclaw/plugin-sdk/session-transcript-runtime" {
  export function withSessionTranscriptWriteLock(
    params: Record<string, unknown>,
    fn: (transcript: {
      readEvents: () => Promise<unknown[]>;
      appendMessage: (params: {
        message: unknown;
        idempotencyLookup?: string;
      }) => Promise<boolean>;
    }) => Promise<boolean>,
  ): Promise<boolean>;
  export function publishSessionTranscriptUpdateByIdentity(
    params: Record<string, unknown>,
  ): Promise<void>;
}

declare module "openclaw/plugin-sdk/agent-harness" {
  export function createOpenClawCodingTools(options: unknown): unknown[] | Promise<unknown[]>;
}
