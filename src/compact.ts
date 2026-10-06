/**
 * Compaction for Cursor harness sessions.
 *
 * Cursor SDK has no native history.compact RPC. We:
 * 1) read the bound agent transcript via Agent.messages.list
 * 2) ask a one-shot Agent.prompt to summarize it
 * 3) return that summary for OpenClaw host/transcript compaction
 *
 * This does not rewrite Cursor's internal agent store; it supplies the
 * summary OpenClaw needs for session continuity after /compact.
 */
import { Agent } from "@cursor/sdk";
import { resolveCursorApiKey } from "./auth.js";
import { readCursorPluginConfig } from "./config.js";
import {
  bindingStoreKey,
  deleteCursorBinding,
  lookupSessionBinding,
  sessionBindingIdentity,
  type CursorBindingStore,
} from "./session-binding.js";

export type CursorCompactParams = {
  sessionId?: string;
  sessionFile?: string;
  sessionKey?: string;
  agentId?: string;
  workspaceDir?: string;
  provider?: string;
  model?: string;
  customInstructions?: string;
  currentTokenCount?: number;
  abortSignal?: AbortSignal;
  config?: unknown;
  resolvedApiKey?: string;
  runId?: string;
  trigger?: string;
};

export type CursorCompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  failure?: { reason?: string; rawError?: string };
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

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatAgentMessagesForSummary(messages: unknown[]): string {
  const lines: string[] = [];
  for (const entry of messages) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const type = (entry as { type?: unknown }).type;
    const message = (entry as { message?: unknown }).message;
    let text = "";
    if (typeof message === "string") {
      text = message;
    } else if (message && typeof message === "object") {
      try {
        text = JSON.stringify(message);
      } catch {
        text = String(message);
      }
    }
    text = text.trim();
    if (!text) {
      continue;
    }
    if (text.length > 4000) {
      text = `${text.slice(0, 4000)}…`;
    }
    lines.push(`${typeof type === "string" ? type : "message"}: ${text}`);
  }
  return lines.join("\n\n");
}

/**
 * Produces a compaction summary for a bound Cursor agent session.
 */
export async function maybeCompactCursorSession(
  params: CursorCompactParams,
  deps: {
    bindingStore: CursorBindingStore;
    pluginConfig?: unknown;
    resolvePluginConfig?: () => unknown;
  },
): Promise<CursorCompactResult> {
  const sessionId = readString(params.sessionId);
  if (!sessionId) {
    return {
      ok: false,
      compacted: false,
      reason: "missing-required-params",
      failure: { reason: "missing-required-params" },
    };
  }

  const identity = sessionBindingIdentity({
    sessionId,
    sessionKey: readString(params.sessionKey),
    agentId: readString(params.agentId),
    config: params.config,
  });
  const binding = lookupSessionBinding(deps.bindingStore, identity);
  if (!binding) {
    return {
      ok: false,
      compacted: false,
      reason: "missing_thread_binding",
      failure: { reason: "missing_thread_binding" },
    };
  }

  if (params.abortSignal?.aborted) {
    return {
      ok: false,
      compacted: false,
      reason: "aborted",
      failure: { reason: "aborted" },
    };
  }

  const pluginConfig = readCursorPluginConfig(
    deps.resolvePluginConfig?.() ?? deps.pluginConfig,
  );

  try {
    const auth = resolveCursorApiKey({
      pluginConfig,
      resolvedApiKey: readString(params.resolvedApiKey),
    });
    const workspaceDir = readString(params.workspaceDir) ?? process.cwd();
    const modelId = readString(params.model) ?? "composer-2.5";

    const listed = await Agent.messages.list(binding.agentId, {
      cwd: workspaceDir,
      limit: 80,
    });
    const transcript = formatAgentMessagesForSummary(listed as unknown[]);
    if (!transcript.trim()) {
      return {
        ok: true,
        compacted: false,
        reason: "already under target",
      };
    }

    const instructions = readString(params.customInstructions);
    const prompt = [
      "Summarize the following Cursor agent conversation for OpenClaw context compaction.",
      "Return a concise handoff summary that preserves goals, decisions, open tasks, and file paths.",
      "Do not modify any files. Reply with ONLY the summary text.",
      instructions ? `Extra instructions: ${instructions}` : "",
      "",
      "Conversation:",
      transcript,
    ]
      .filter(Boolean)
      .join("\n");

    const result = await Agent.prompt(prompt, {
      apiKey: auth.apiKey,
      model: { id: modelId },
      local: {
        cwd: workspaceDir,
        settingSources: [],
        ...(pluginConfig.local.sandboxEnabled ? { sandboxOptions: { enabled: true } } : {}),
        ...(pluginConfig.local.autoReview ? { autoReview: true } : {}),
      },
    });

    if (params.abortSignal?.aborted) {
      return {
        ok: false,
        compacted: false,
        reason: "aborted",
        failure: { reason: "aborted" },
      };
    }

    if (result.status === "error") {
      return {
        ok: false,
        compacted: false,
        reason: "cursor-summary-compact-failed",
        failure: {
          reason: "cursor-summary-compact-failed",
          rawError: `run ${result.id} status=error`,
        },
      };
    }

    const summary = typeof result.result === "string" ? result.result.trim() : "";
    if (!summary) {
      return {
        ok: true,
        compacted: false,
        reason: "already under target",
      };
    }

    return {
      ok: true,
      compacted: true,
      reason: "cursor-summary-compacted",
      result: {
        summary,
        firstKeptEntryId: "",
        tokensBefore: params.currentTokenCount ?? 0,
        details: {
          agentId: binding.agentId,
          messageCount: listed.length,
          mode: "summary-oneshot",
        },
        sessionId,
        sessionFile: params.sessionFile,
      },
    };
  } catch (error) {
    const rawError = error instanceof Error ? error.message : String(error);
    if (/\b(404|not found|unknown agent|stale)\b/i.test(rawError)) {
      deleteCursorBinding(deps.bindingStore, bindingStoreKey(identity));
      deleteCursorBinding(deps.bindingStore, sessionId);
      return {
        ok: false,
        compacted: false,
        reason: "stale_thread_binding",
        failure: { reason: "stale_thread_binding", rawError },
      };
    }
    return {
      ok: false,
      compacted: false,
      reason: "cursor-summary-compact-failed",
      failure: { reason: "cursor-summary-compact-failed", rawError },
    };
  }
}
