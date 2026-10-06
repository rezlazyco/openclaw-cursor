/**
 * Shared attempt result helpers for the Cursor harness.
 */
import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CursorMessagingTarget, CursorToolTelemetry } from "./tool-bridge.js";

export type AttemptResultWithAgentId = AgentHarnessAttemptResult & { cursorAgentId?: string };

export function createEmptyMessages(params: AgentHarnessAttemptParams): AgentMessage[] {
  const prompt =
    typeof params.transcriptPrompt === "string" && params.transcriptPrompt.trim()
      ? params.transcriptPrompt
      : params.prompt;
  return prompt
    ? [
        {
          role: "user",
          content: prompt,
          timestamp: Date.now(),
        } as AgentMessage,
      ]
    : [];
}

export function createCursorAttemptResult(params: {
  attempt: AgentHarnessAttemptParams;
  aborted?: boolean;
  externalAbort?: boolean;
  timedOut?: boolean;
  promptError?: unknown;
  assistantTexts?: string[];
  toolMetas?: Array<{ toolName: string; meta?: string }>;
  messagesSnapshot?: AgentMessage[];
  cursorAgentId?: string;
  replayInvalid?: boolean;
  hadPotentialSideEffects?: boolean;
  telemetry?: Pick<
    CursorToolTelemetry,
    | "didSendViaMessagingTool"
    | "messagingToolSentTexts"
    | "messagingToolSentMediaUrls"
    | "messagingToolSentTargets"
  >;
  attemptUsage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoningTokens?: number;
    total?: number;
  };
}): AttemptResultWithAgentId {
  const promptError = params.promptError;
  const assistantTexts = params.assistantTexts ?? [];
  const lastText = [...assistantTexts].reverse().find((text) => text.trim()) ?? "";
  const lastAssistant = lastText
    ? ({
        role: "assistant",
        content: [{ type: "text", text: lastText }],
        timestamp: Date.now(),
      } as AgentHarnessAttemptResult["lastAssistant"])
    : undefined;
  const telemetry = params.telemetry;
  const messagingTargets = (telemetry?.messagingToolSentTargets ?? []) as CursorMessagingTarget[];

  return {
    aborted: params.aborted === true,
    externalAbort: params.externalAbort === true,
    timedOut: params.timedOut === true,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    promptError,
    promptErrorSource: promptError ? "prompt" : null,
    sessionIdUsed: params.attempt.sessionId,
    sessionFileUsed: params.attempt.sessionFile,
    messagesSnapshot: params.messagesSnapshot ?? createEmptyMessages(params.attempt),
    assistantTexts,
    toolMetas: params.toolMetas ?? [],
    lastAssistant,
    currentAttemptAssistant: lastAssistant,
    didSendViaMessagingTool: telemetry?.didSendViaMessagingTool === true,
    messagingToolSentTexts: telemetry?.messagingToolSentTexts ?? [],
    messagingToolSentMediaUrls: telemetry?.messagingToolSentMediaUrls ?? [],
    messagingToolSentTargets: messagingTargets as never,
    cloudCodeAssistFormatError: false,
    itemLifecycle: {
      activeCount: 0,
      completedCount: params.toolMetas?.length ?? 0,
      startedCount: params.toolMetas?.length ?? 0,
    },
    replayMetadata: {
      replaySafe: params.replayInvalid !== true,
      hadPotentialSideEffects:
        params.hadPotentialSideEffects === true || telemetry?.didSendViaMessagingTool === true,
    },
    yieldDetected: false,
    ...(params.cursorAgentId ? { cursorAgentId: params.cursorAgentId } : {}),
    ...(params.attemptUsage ? { attemptUsage: params.attemptUsage } : {}),
  };
}

export function createPromptError(code: string, message: string, cause?: unknown): Error & {
  code: string;
} {
  const error = new Error(message) as Error & { code: string; cause?: unknown };
  error.code = code;
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}
