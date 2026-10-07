/**
 * Cursor SDK custom tool for spawning and tracking background jobs.
 */
import type { SDKCustomTool } from "@cursor/sdk";
import {
  BackgroundJobConcurrencyError,
  BackgroundJobNotFoundError,
  buildBackgroundJobNotifyContext,
  getBackgroundJobRegistry,
  type BackgroundJobPublic,
} from "./background-jobs.js";
import { readCursorPluginConfig, type CursorPluginConfig } from "./config.js";
import type { CursorToolBridgeParams } from "./tool-bridge.js";

export const OPENCLAW_BACKGROUND_JOB_TOOL_NAME = "openclaw_background_job";

export type BuildBackgroundJobCustomToolsParams = {
  pluginConfig: CursorPluginConfig;
  workspaceDir: string;
  modelId: string;
  bridgeParams: CursorToolBridgeParams;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readLimit(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 50) {
    return value;
  }
  return 20;
}

function formatJobSummary(job: BackgroundJobPublic): Record<string, unknown> {
  return {
    jobId: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    cursorAgentId: job.cursorAgentId,
    runId: job.runId,
    summary: job.lastAssistantSnippet,
    error: job.error,
  };
}

function formatResult(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, null, 2);
}

/** Builds the `openclaw_background_job` custom tool when background jobs are enabled. */
export function buildBackgroundJobCustomTools(
  params: BuildBackgroundJobCustomToolsParams,
): Record<string, SDKCustomTool> | undefined {
  if (params.pluginConfig.runtime !== "local") {
    return undefined;
  }
  if (!params.pluginConfig.local.backgroundJobs.enabled) {
    return undefined;
  }

  const registry = getBackgroundJobRegistry(params.pluginConfig);
  const notifyContext = buildBackgroundJobNotifyContext(params.bridgeParams);
  const sessionKey =
    readString(params.bridgeParams.sessionKey) ?? readString(params.bridgeParams.sessionId);

  const tool: SDKCustomTool = {
    description:
      "Use when the user task is large, multi-step, slow, or they want async/background work. " +
      "Before editing files or running shell for such work, call action=spawn with task=full instructions; " +
      "then tell the user only the jobId from this tool's response (never invent UUIDs). " +
      "status/list/cancel for follow-up.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["spawn", "status", "list", "cancel"],
        },
        task: {
          type: "string",
          description: "Full task prompt for action=spawn.",
        },
        jobId: {
          type: "string",
          description: "Job id for action=status or action=cancel.",
        },
        model: {
          type: "string",
          description: "Optional model id override for action=spawn.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Max jobs returned for action=list.",
        },
      },
      required: ["action"],
    },
    async execute(args) {
      const record = asRecord(args);
      const action = readString(record.action);
      if (!action) {
        return formatResult({ error: "action is required" });
      }

      try {
        if (action === "spawn") {
          const task = readString(record.task);
          if (!task) {
            return formatResult({ error: "task is required for spawn" });
          }
          const modelId = readString(record.model) ?? params.modelId;
          const job = await registry.spawn({
            pluginConfig: params.pluginConfig,
            task,
            modelId,
            workspaceDir: params.workspaceDir,
            ...(sessionKey ? { sessionKey } : {}),
            notifyContext,
          });
          return formatResult({
            ok: true,
            action,
            ...formatJobSummary(job),
            message: "Background job started. Tell the user you took the task and share the jobId.",
          });
        }

        if (action === "status") {
          const jobId = readString(record.jobId);
          if (!jobId) {
            return formatResult({ error: "jobId is required for status" });
          }
          const job = registry.getJobPublic(jobId);
          if (!job) {
            throw new BackgroundJobNotFoundError(jobId);
          }
          return formatResult({ ok: true, action, ...formatJobSummary(job) });
        }

        if (action === "list") {
          const limit = readLimit(record.limit);
          const jobs = registry.listJobs(sessionKey, limit);
          return formatResult({ ok: true, action, jobs: jobs.map(formatJobSummary) });
        }

        if (action === "cancel") {
          const jobId = readString(record.jobId);
          if (!jobId) {
            return formatResult({ error: "jobId is required for cancel" });
          }
          const job = await registry.cancel(jobId);
          return formatResult({ ok: true, action, ...formatJobSummary(job) });
        }

        return formatResult({ error: `unsupported action: ${action}` });
      } catch (error) {
        if (error instanceof BackgroundJobConcurrencyError) {
          return formatResult({ ok: false, error: error.message });
        }
        if (error instanceof BackgroundJobNotFoundError) {
          return formatResult({ ok: false, error: error.message });
        }
        const message = error instanceof Error ? error.message : String(error);
        return formatResult({ ok: false, error: message });
      }
    },
  };

  return { [OPENCLAW_BACKGROUND_JOB_TOOL_NAME]: tool };
}

export function resolveBackgroundJobCustomToolsForAttempt(params: {
  pluginConfig: unknown;
  runtime: CursorPluginConfig["runtime"];
  workspaceDir: string;
  modelId: string;
  bridgeParams: CursorToolBridgeParams;
}): Record<string, SDKCustomTool> | undefined {
  const pluginConfig = readCursorPluginConfig(params.pluginConfig);
  if (params.runtime !== "local" || !pluginConfig.local.backgroundJobs.enabled) {
    return undefined;
  }
  return buildBackgroundJobCustomTools({
    pluginConfig,
    workspaceDir: params.workspaceDir,
    modelId: params.modelId,
    bridgeParams: params.bridgeParams,
  });
}
