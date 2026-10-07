/**
 * Structured Cursor run / SDK failure details for user messages and gateway logs.
 */
import { CursorAgentError, CursorSdkError, type RunResult } from "@cursor/sdk";
import { createPromptError } from "./result.js";

export type CursorFailureKind =
  | "run_error"
  | "cursor_agent_error"
  | "attempt_failed"
  | "timeout";

export type CursorFailureDetails = {
  kind: CursorFailureKind;
  message: string;
  runId?: string;
  requestId?: string;
  cursorAgentId?: string;
  runErrorCode?: string;
  streamError?: string;
  sdkError?: Record<string, unknown>;
};

export type CursorPluginLogger = {
  warn?: (message: string) => void;
  debug?: (message: string) => void;
};

function readRunResultFailure(result: RunResult | undefined): {
  runId?: string;
  requestId?: string;
  runErrorMessage?: string;
  runErrorCode?: string;
} {
  if (!result) {
    return {};
  }
  return {
    runId: result.id,
    requestId: result.requestId,
    runErrorMessage: result.error?.message,
    runErrorCode: result.error?.code,
  };
}

function serializeSdkError(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof CursorSdkError) {
    return error.toJSON();
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  if (error !== undefined && error !== null) {
    return { value: String(error) };
  }
  return undefined;
}

function pickPrimaryMessage(parts: Array<string | undefined>): string {
  for (const part of parts) {
    const trimmed = part?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "Cursor run failed";
}

function appendCorrelationSuffix(
  message: string,
  details: Pick<
    CursorFailureDetails,
    "runId" | "requestId" | "cursorAgentId" | "runErrorCode"
  >,
): string {
  const bits: string[] = [];
  if (details.runId) {
    bits.push(`runId=${details.runId}`);
  }
  if (details.requestId) {
    bits.push(`requestId=${details.requestId}`);
  }
  if (details.cursorAgentId) {
    bits.push(`agentId=${details.cursorAgentId}`);
  }
  if (details.runErrorCode) {
    bits.push(`code=${details.runErrorCode}`);
  }
  if (bits.length === 0) {
    return message;
  }
  return `${message} (${bits.join(", ")})`;
}

export function buildCursorFailure(params: {
  kind: CursorFailureKind;
  runResult?: RunResult;
  streamError?: Error;
  caught?: unknown;
  cursorAgentId?: string;
  fallbackMessage?: string;
}): CursorFailureDetails {
  const fromRun = readRunResultFailure(params.runResult);
  const streamMessage = params.streamError?.message?.trim();
  const caughtMessage =
    params.caught instanceof Error ? params.caught.message : undefined;
  const sdkError = serializeSdkError(params.caught);

  const runErrorCode =
    fromRun.runErrorCode ??
    (sdkError && typeof sdkError.code === "string" ? sdkError.code : undefined);

  const primary = pickPrimaryMessage([
    fromRun.runErrorMessage,
    streamMessage,
    caughtMessage,
    params.fallbackMessage,
  ]);

  const message = appendCorrelationSuffix(primary, {
    runId: fromRun.runId,
    requestId: fromRun.requestId,
    cursorAgentId: params.cursorAgentId,
    runErrorCode,
  });

  return {
    kind: params.kind,
    message,
    ...(fromRun.runId ? { runId: fromRun.runId } : {}),
    ...(fromRun.requestId ? { requestId: fromRun.requestId } : {}),
    ...(params.cursorAgentId ? { cursorAgentId: params.cursorAgentId } : {}),
    ...(runErrorCode ? { runErrorCode } : {}),
    ...(streamMessage ? { streamError: streamMessage } : {}),
    ...(sdkError ? { sdkError } : {}),
  };
}

export function promptErrorFromCursorFailure(
  failure: CursorFailureDetails,
  cause?: unknown,
): Error & { code: string; cursorFailure?: CursorFailureDetails } {
  const error = createPromptError(failure.kind, failure.message, cause) as Error & {
    code: string;
    cursorFailure?: CursorFailureDetails;
  };
  error.cursorFailure = failure;
  return error;
}

export function logCursorFailure(
  logger: CursorPluginLogger | undefined,
  scope: string,
  failure: CursorFailureDetails,
): void {
  if (!logger) {
    return;
  }
  const payload = JSON.stringify(failure);
  logger.warn?.(`cursor: ${scope}: ${failure.message}`);
  logger.debug?.(`cursor: ${scope} details: ${payload}`);
}

export function failureKindForCaught(error: unknown): CursorFailureKind {
  return error instanceof CursorAgentError ? "cursor_agent_error" : "attempt_failed";
}
