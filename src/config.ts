/**
 * Cursor plugin config resolution.
 */
export type CursorRuntimeMode = "local" | "cloud";

export type CursorPluginConfig = {
  runtime: CursorRuntimeMode;
  apiKeyEnv: string;
  discovery: {
    enabled: boolean;
    timeoutMs: number;
  };
  local: {
    settingSources: Array<"project" | "user" | "team" | "mdm" | "all">;
    sandboxEnabled: boolean;
    /** Enable Cursor Auto-review classifier for local tool calls when available. */
    autoReview: boolean;
    /**
     * Force HTTP/1.1 + SSE for agent backend streams (needed behind many
     * corporate / country proxies that break HTTP/2).
     */
    useHttp1ForAgent: boolean;
    backgroundJobs: {
      enabled: boolean;
      maxConcurrent: number;
      notifyOnComplete: boolean;
      persistJobs: boolean;
    };
  };
  cloud: {
    repoUrl?: string;
    startingRef?: string;
    autoCreatePR: boolean;
    skipReviewerRequest: boolean;
  };
  cursorDynamicToolsExclude: string[];
};

const DEFAULTS: CursorPluginConfig = {
  runtime: "local",
  apiKeyEnv: "CURSOR_API_KEY",
  discovery: {
    enabled: true,
    timeoutMs: 15000,
  },
  local: {
    settingSources: [],
    sandboxEnabled: false,
    autoReview: false,
    useHttp1ForAgent: false,
    backgroundJobs: {
      enabled: true,
      maxConcurrent: 2,
      notifyOnComplete: true,
      persistJobs: false,
    },
  },
  cloud: {
    autoCreatePR: false,
    skipReviewerRequest: true,
  },
  cursorDynamicToolsExclude: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function readSettingSources(
  value: unknown,
): Array<"project" | "user" | "team" | "mdm" | "all"> {
  if (!Array.isArray(value)) {
    return [...DEFAULTS.local.settingSources];
  }
  const allowed = new Set(["project", "user", "team", "mdm", "all"]);
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item): item is "project" | "user" | "team" | "mdm" | "all" => allowed.has(item));
}

/** Reads and normalizes `plugins.entries.cursor.config`. */
export function readCursorPluginConfig(pluginConfig: unknown): CursorPluginConfig {
  if (!isRecord(pluginConfig)) {
    return structuredClone(DEFAULTS);
  }

  const discovery = isRecord(pluginConfig.discovery) ? pluginConfig.discovery : {};
  const local = isRecord(pluginConfig.local) ? pluginConfig.local : {};
  const backgroundJobs = isRecord(local.backgroundJobs) ? local.backgroundJobs : {};
  const cloud = isRecord(pluginConfig.cloud) ? pluginConfig.cloud : {};
  const runtimeRaw = readString(pluginConfig.runtime)?.toLowerCase();
  const runtime: CursorRuntimeMode = runtimeRaw === "cloud" ? "cloud" : "local";

  const exclude = Array.isArray(pluginConfig.cursorDynamicToolsExclude)
    ? pluginConfig.cursorDynamicToolsExclude
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [...DEFAULTS.cursorDynamicToolsExclude];

  return {
    runtime,
    apiKeyEnv: readString(pluginConfig.apiKeyEnv) ?? DEFAULTS.apiKeyEnv,
    discovery: {
      enabled: readBoolean(discovery.enabled, DEFAULTS.discovery.enabled),
      timeoutMs: readNumber(discovery.timeoutMs, DEFAULTS.discovery.timeoutMs),
    },
    local: {
      settingSources: readSettingSources(local.settingSources),
      sandboxEnabled: readBoolean(local.sandboxEnabled, DEFAULTS.local.sandboxEnabled),
      autoReview: readBoolean(local.autoReview, DEFAULTS.local.autoReview),
      useHttp1ForAgent: readBoolean(local.useHttp1ForAgent, DEFAULTS.local.useHttp1ForAgent),
      backgroundJobs: {
        enabled: readBoolean(backgroundJobs.enabled, DEFAULTS.local.backgroundJobs.enabled),
        maxConcurrent: readNumber(
          backgroundJobs.maxConcurrent,
          DEFAULTS.local.backgroundJobs.maxConcurrent,
        ),
        notifyOnComplete: readBoolean(
          backgroundJobs.notifyOnComplete,
          DEFAULTS.local.backgroundJobs.notifyOnComplete,
        ),
        persistJobs: readBoolean(
          backgroundJobs.persistJobs,
          DEFAULTS.local.backgroundJobs.persistJobs,
        ),
      },
    },
    cloud: {
      repoUrl: readString(cloud.repoUrl),
      startingRef: readString(cloud.startingRef),
      autoCreatePR: readBoolean(cloud.autoCreatePR, DEFAULTS.cloud.autoCreatePR),
      skipReviewerRequest: readBoolean(
        cloud.skipReviewerRequest,
        DEFAULTS.cloud.skipReviewerRequest,
      ),
    },
    cursorDynamicToolsExclude: exclude,
  };
}
