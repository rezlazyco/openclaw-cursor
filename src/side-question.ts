/**
 * Side-question runner: isolated one-shot Cursor agent (does not pollute
 * the bound conversation agentId).
 */
import { Agent } from "@cursor/sdk";
import { resolveCursorApiKey } from "./auth.js";
import { readCursorPluginConfig } from "./config.js";
import { buildCursorMcpServers } from "./mcp-bridge.js";

export type CursorSideQuestionParams = {
  question: string;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  provider?: string;
  model?: string;
  sessionId?: string;
  sessionKey?: string;
  config?: unknown;
  resolvedApiKey?: string;
  abortSignal?: AbortSignal;
};

export type CursorSideQuestionResult = {
  text: string;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Answers a side question without mutating the durable Cursor agent binding.
 */
export async function runCursorSideQuestion(
  params: CursorSideQuestionParams,
  deps: { pluginConfig?: unknown; resolvePluginConfig?: () => unknown } = {},
): Promise<CursorSideQuestionResult> {
  if (params.abortSignal?.aborted) {
    throw new Error("aborted");
  }

  const pluginConfig = readCursorPluginConfig(
    deps.resolvePluginConfig?.() ?? deps.pluginConfig,
  );
  const auth = resolveCursorApiKey({
    pluginConfig,
    resolvedApiKey: readString(params.resolvedApiKey),
  });
  const workspaceDir =
    readString(params.workspaceDir) ?? readString(params.agentDir) ?? process.cwd();
  const modelId = readString(params.model) ?? "composer-2.5";
  const mcpServers = buildCursorMcpServers({
    config: params.config,
    agentId: readString(params.agentId),
  });

  const prompt = [
    "You are answering a short side question for an OpenClaw agent runtime.",
    "Reply with a concise factual answer only. Do not modify files unless the question explicitly requires it.",
    "",
    params.question.trim(),
  ].join("\n");

  if (pluginConfig.runtime === "cloud") {
    const repoUrl = pluginConfig.cloud.repoUrl;
    if (!repoUrl) {
      throw new Error(
        "Cursor cloud runtime requires plugins.entries.cursor.config.cloud.repoUrl for side questions",
      );
    }
    const result = await Agent.prompt(prompt, {
      apiKey: auth.apiKey,
      model: { id: modelId },
      ...(mcpServers ? { mcpServers } : {}),
      cloud: {
        repos: [
          {
            url: repoUrl,
            ...(pluginConfig.cloud.startingRef
              ? { startingRef: pluginConfig.cloud.startingRef }
              : {}),
          },
        ],
        autoCreatePR: false,
        skipReviewerRequest: true,
      },
    });
    if (params.abortSignal?.aborted) {
      throw new Error("aborted");
    }
    if (result.status === "error") {
      throw new Error(`Cursor side question failed (run ${result.id})`);
    }
    return { text: typeof result.result === "string" ? result.result : "" };
  }

  const result = await Agent.prompt(prompt, {
    apiKey: auth.apiKey,
    model: { id: modelId },
    ...(mcpServers ? { mcpServers } : {}),
    local: {
      cwd: workspaceDir,
      settingSources: pluginConfig.local.settingSources,
      ...(pluginConfig.local.sandboxEnabled ? { sandboxOptions: { enabled: true } } : {}),
      ...(pluginConfig.local.autoReview ? { autoReview: true } : {}),
    },
  });
  if (params.abortSignal?.aborted) {
    throw new Error("aborted");
  }
  if (result.status === "error") {
    throw new Error(`Cursor side question failed (run ${result.id})`);
  }
  return { text: typeof result.result === "string" ? result.result : "" };
}
