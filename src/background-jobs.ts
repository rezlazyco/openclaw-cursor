/**
 * Background Cursor agents spawned outside the blocking harness turn.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent, type SDKAgent } from "@cursor/sdk";
import { resolveCursorApiKey } from "./auth.js";
import type { CursorPluginConfig } from "./config.js";
import { createCursorStreamBridge } from "./event-bridge.js";
import { applyCursorSdkNetworkConfig } from "./sdk-network.js";
import { deliverBackgroundJobCompletion } from "./background-jobs-deliver.js";
import type { CursorToolBridgeParams } from "./tool-bridge.js";

export type BackgroundJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type BackgroundJobNotifyContext = Pick<
  CursorToolBridgeParams,
  | "sessionId"
  | "sessionKey"
  | "agentId"
  | "workspaceDir"
  | "cwd"
  | "agentDir"
  | "config"
  | "messageProvider"
  | "messageChannel"
  | "agentAccountId"
  | "messageTo"
  | "messageThreadId"
  | "senderIsOwner"
  | "senderId"
  | "senderName"
  | "senderUsername"
  | "groupId"
  | "groupChannel"
  | "groupSpace"
>;

export type BackgroundJob = {
  id: string;
  status: BackgroundJobStatus;
  createdAt: number;
  updatedAt: number;
  prompt: string;
  modelId: string;
  workspaceDir: string;
  sessionKey?: string;
  cursorAgentId?: string;
  runId?: string;
  lastAssistantSnippet?: string;
  error?: string;
  notifyContext?: BackgroundJobNotifyContext;
};

export type BackgroundJobPublic = Omit<BackgroundJob, "notifyContext">;

type ActiveRunHandle = {
  cancel: () => Promise<void>;
};

export type SpawnBackgroundJobParams = {
  pluginConfig: CursorPluginConfig;
  task: string;
  modelId: string;
  workspaceDir: string;
  sessionKey?: string;
  notifyContext?: BackgroundJobNotifyContext;
};

export class BackgroundJobConcurrencyError extends Error {
  constructor(maxConcurrent: number) {
    super(`background job limit reached (maxConcurrent=${maxConcurrent})`);
    this.name = "BackgroundJobConcurrencyError";
  }
}

export class BackgroundJobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`background job not found: ${jobId}`);
    this.name = "BackgroundJobNotFoundError";
  }
}

function resolveDefaultStateDir(): string {
  const fromEnv = process.env.OPENCLAW_STATE_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return path.join(os.homedir(), ".openclaw");
}

function defaultPersistPath(): string {
  return path.join(resolveDefaultStateDir(), "cursor", "background-jobs.json");
}

function toPublicJob(job: BackgroundJob): BackgroundJobPublic {
  const { notifyContext: _notify, ...rest } = job;
  return rest;
}

function snippetFromTexts(texts: string[], maxLen = 500): string | undefined {
  const joined = texts.join("\n").trim();
  if (!joined) {
    return undefined;
  }
  if (joined.length <= maxLen) {
    return joined;
  }
  return `${joined.slice(0, maxLen - 1)}…`;
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

function buildJobCompletionUserMessage(job: BackgroundJob): string {
  const summary =
    job.lastAssistantSnippet?.trim() ||
    (job.status === "succeeded"
      ? "Background job completed (no assistant text captured)."
      : job.error?.trim() || `Status: ${job.status}`);
  const statusLabel =
    job.status === "succeeded"
      ? "завершена"
      : job.status === "failed"
        ? "ошибка"
        : job.status === "cancelled"
          ? "отменена"
          : job.status;
  return `Фоновая задача ${job.id} ${statusLabel}.\n\n${summary}`;
}

async function notifyJobTerminal(
  job: BackgroundJob,
  pluginConfig: CursorPluginConfig,
): Promise<void> {
  if (!pluginConfig.local.backgroundJobs.notifyOnComplete) {
    return;
  }
  if (job.status !== "succeeded" && job.status !== "failed" && job.status !== "cancelled") {
    return;
  }

  const text = buildJobCompletionUserMessage(job);
  await deliverBackgroundJobCompletion({
    notifyContext: job.notifyContext,
    sessionKey: job.sessionKey,
    jobId: job.id,
    text,
  });
}

class BackgroundJobRegistry {
  private jobs = new Map<string, BackgroundJob>();
  private activeRuns = new Map<string, ActiveRunHandle>();
  private persistPath?: string;

  configurePersist(persistJobs: boolean, persistPath?: string): void {
    this.persistPath = persistJobs ? (persistPath ?? defaultPersistPath()) : undefined;
    if (this.persistPath) {
      this.loadFromDisk();
    }
  }

  private loadFromDisk(): void {
    if (!this.persistPath) {
      return;
    }
    try {
      if (!fs.existsSync(this.persistPath)) {
        return;
      }
      const raw = fs.readFileSync(this.persistPath, "utf8");
      const parsed = JSON.parse(raw) as { jobs?: BackgroundJob[] };
      if (!Array.isArray(parsed.jobs)) {
        return;
      }
      for (const job of parsed.jobs) {
        if (!job?.id || typeof job.id !== "string") {
          continue;
        }
        if (job.status === "running" || job.status === "queued") {
          job.status = "failed";
          job.error = "interrupted (registry reloaded)";
          job.updatedAt = Date.now();
        }
        this.jobs.set(job.id, job);
      }
    } catch {
      // Ignore corrupt persistence files.
    }
  }

  private persistToDisk(): void {
    if (!this.persistPath) {
      return;
    }
    try {
      const dir = path.dirname(this.persistPath);
      fs.mkdirSync(dir, { recursive: true });
      const jobs = [...this.jobs.values()].map((job) => ({
        ...job,
        notifyContext: undefined,
      }));
      fs.writeFileSync(this.persistPath, JSON.stringify({ jobs }, null, 2), "utf8");
    } catch {
      // Best-effort persistence.
    }
  }

  private touch(job: BackgroundJob): void {
    job.updatedAt = Date.now();
    this.jobs.set(job.id, job);
    this.persistToDisk();
  }

  countRunning(): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "running" || job.status === "queued") {
        count += 1;
      }
    }
    return count;
  }

  getJob(jobId: string): BackgroundJob | undefined {
    return this.jobs.get(jobId);
  }

  getJobPublic(jobId: string): BackgroundJobPublic | undefined {
    const job = this.jobs.get(jobId);
    return job ? toPublicJob(job) : undefined;
  }

  listJobs(sessionKey?: string, limit = 20): BackgroundJobPublic[] {
    const items = [...this.jobs.values()]
      .filter((job) => !sessionKey || job.sessionKey === sessionKey)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(toPublicJob);
    return items;
  }

  async spawn(params: SpawnBackgroundJobParams): Promise<BackgroundJobPublic> {
    const { pluginConfig } = params;
    const maxConcurrent = pluginConfig.local.backgroundJobs.maxConcurrent;
    if (this.countRunning() >= maxConcurrent) {
      throw new BackgroundJobConcurrencyError(maxConcurrent);
    }

    const id = randomUUID();
    const now = Date.now();
    const job: BackgroundJob = {
      id,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      prompt: params.task,
      modelId: params.modelId,
      workspaceDir: params.workspaceDir,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.notifyContext ? { notifyContext: params.notifyContext } : {}),
    };
    this.touch(job);

    const snapshot = toPublicJob({ ...job });
    void this.runJob(job, pluginConfig).catch(() => undefined);
    return snapshot;
  }

  async cancel(jobId: string): Promise<BackgroundJobPublic> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new BackgroundJobNotFoundError(jobId);
    }
    if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
      return toPublicJob(job);
    }
    const active = this.activeRuns.get(jobId);
    if (active) {
      await active.cancel().catch(() => undefined);
    }
    job.status = "cancelled";
    job.updatedAt = Date.now();
    this.touch(job);
    this.activeRuns.delete(jobId);
    return toPublicJob(job);
  }

  private async runJob(job: BackgroundJob, pluginConfig: CursorPluginConfig): Promise<void> {
    job.status = "running";
    this.touch(job);

    let agent: SDKAgent | undefined;
    try {
      applyCursorSdkNetworkConfig(pluginConfig);
      const auth = resolveCursorApiKey({ pluginConfig });
      agent = await Agent.create({
        apiKey: auth.apiKey,
        model: { id: job.modelId },
        local: {
          cwd: job.workspaceDir,
          settingSources: pluginConfig.local.settingSources,
          ...(pluginConfig.local.sandboxEnabled
            ? { sandboxOptions: { enabled: true } }
            : {}),
          ...(pluginConfig.local.autoReview ? { autoReview: true } : {}),
        },
      });
      job.cursorAgentId = agent.agentId;
      this.touch(job);

      const run = await agent.send(job.prompt);
      job.runId = run.id;
      this.touch(job);

      this.activeRuns.set(job.id, {
        cancel: async () => {
          if (run.supports("cancel")) {
            await run.cancel();
          }
        },
      });

      const bridge = createCursorStreamBridge();
      for await (const event of run.stream()) {
        await bridge.handleMessage(event);
        const partial = bridge.state.currentAssistantText.trim();
        if (partial) {
          job.lastAssistantSnippet = snippetFromTexts([partial]);
          job.updatedAt = Date.now();
        }
      }

      const result = await run.wait();
      if (this.jobs.get(job.id)?.status === "cancelled") {
        return;
      }

      const finalTexts = bridge.finalizeAssistantTexts();
      const snippet = snippetFromTexts(finalTexts);
      if (snippet) {
        job.lastAssistantSnippet = snippet;
      }

      if (result.status === "cancelled") {
        job.status = "cancelled";
      } else if (result.status === "error" || bridge.state.streamError) {
        job.status = "failed";
        job.error =
          bridge.state.streamError?.message ??
          `Cursor run ${result.id} failed with status ${result.status}`;
      } else {
        job.status = "succeeded";
      }
      job.updatedAt = Date.now();
      this.touch(job);

      await notifyJobTerminal(job, pluginConfig);
    } catch (error) {
      if (this.jobs.get(job.id)?.status !== "cancelled") {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        job.updatedAt = Date.now();
        this.touch(job);
      }
    } finally {
      this.activeRuns.delete(job.id);
      await disposeAgent(agent);
    }
  }
}

let registrySingleton: BackgroundJobRegistry | undefined;

export function getBackgroundJobRegistry(pluginConfig: CursorPluginConfig): BackgroundJobRegistry {
  if (!registrySingleton) {
    registrySingleton = new BackgroundJobRegistry();
  }
  registrySingleton.configurePersist(
    pluginConfig.local.backgroundJobs.persistJobs,
    pluginConfig.local.backgroundJobs.persistJobs ? defaultPersistPath() : undefined,
  );
  return registrySingleton;
}

/** Test-only: reset in-memory registry between unit tests. */
export function resetBackgroundJobRegistryForTests(): void {
  registrySingleton = undefined;
}

export function buildBackgroundJobNotifyContext(
  params: CursorToolBridgeParams,
): BackgroundJobNotifyContext {
  return {
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    ...(params.cwd ? { cwd: params.cwd } : {}),
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    ...(params.config !== undefined ? { config: params.config } : {}),
    ...(params.messageProvider ? { messageProvider: params.messageProvider } : {}),
    ...(params.messageChannel ? { messageChannel: params.messageChannel } : {}),
    ...(params.agentAccountId ? { agentAccountId: params.agentAccountId } : {}),
    ...(params.messageTo ? { messageTo: params.messageTo } : {}),
    ...(params.messageThreadId !== undefined
      ? { messageThreadId: params.messageThreadId }
      : {}),
    ...(params.senderIsOwner !== undefined ? { senderIsOwner: params.senderIsOwner } : {}),
    ...(params.senderId ? { senderId: params.senderId } : {}),
    ...(params.senderName ? { senderName: params.senderName } : {}),
    ...(params.senderUsername ? { senderUsername: params.senderUsername } : {}),
    ...(params.groupId ? { groupId: params.groupId } : {}),
    ...(params.groupChannel ? { groupChannel: params.groupChannel } : {}),
    ...(params.groupSpace ? { groupSpace: params.groupSpace } : {}),
  };
}
