/**
 * Cursor provider plugin and live model catalog discovery via @cursor/sdk.
 */
import { createSubsystemLogger } from "openclaw/plugin-sdk/core";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  normalizeModelCompat,
  type ModelProviderConfig,
  type ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import { resolveCursorSystemPromptContribution } from "./prompt-overlay.js";
import {
  buildCursorModelDefinition,
  buildCursorProviderConfig,
  CURSOR_PROVIDER_ID,
  CURSOR_SDK_AUTH_MARKER,
  FALLBACK_CURSOR_MODELS,
  mergeCursorCatalogModels,
  normalizeCursorCatalogModelId,
  type CursorCatalogModel,
} from "./provider-catalog.js";
import { resolveCursorApiKey } from "./src/auth.js";
import { readCursorPluginConfig } from "./src/config.js";

const LIVE_DISCOVERY_ENV = "OPENCLAW_CURSOR_DISCOVERY_LIVE";
const cursorCatalogLog = createSubsystemLogger("cursor/catalog");
const CURSOR_API_KEY_ENV = "CURSOR_API_KEY";
const CURSOR_DEFAULT_MODEL_REF = `${CURSOR_PROVIDER_ID}/${FALLBACK_CURSOR_MODELS[0].id}`;

type BuildCursorProviderOptions = {
  pluginConfig?: unknown;
  listModels?: (options: {
    apiKey: string;
    timeoutMs: number;
  }) => Promise<CursorCatalogModel[]>;
};

type BuildCatalogOptions = {
  env?: NodeJS.ProcessEnv;
  pluginConfig?: unknown;
  listModels?: BuildCursorProviderOptions["listModels"];
};

/**
 * Builds the Cursor provider plugin, including setup metadata, catalog discovery,
 * dynamic model resolution, and prompt hooks.
 */
export function buildCursorProvider(options: BuildCursorProviderOptions = {}): ProviderPlugin {
  return {
    id: CURSOR_PROVIDER_ID,
    label: "Cursor",
    docsPath: "/providers/models",
    envVars: [CURSOR_API_KEY_ENV],
    auth: [
      createProviderApiKeyAuthMethod({
        providerId: CURSOR_PROVIDER_ID,
        methodId: "api-key",
        label: "Cursor API key",
        hint: "Cursor Dashboard → Integrations (or team service-account key).",
        optionKey: "cursorApiKey",
        flagName: "--cursor-api-key",
        envVar: CURSOR_API_KEY_ENV,
        promptMessage: "Enter Cursor API key (crsr_…)",
        defaultModel: CURSOR_DEFAULT_MODEL_REF,
        expectedProviders: [CURSOR_PROVIDER_ID],
        wizard: {
          choiceId: "cursor-api-key",
          choiceLabel: "Cursor API key",
          choiceHint: "Use @cursor/sdk with a Cursor API key.",
          assistantPriority: -35,
          groupId: CURSOR_PROVIDER_ID,
          groupLabel: "Cursor",
          groupHint: "Cursor SDK model provider",
          onboardingScopes: ["text-inference"],
        },
      }),
    ],
    catalog: {
      order: "late",
      run: async (ctx: { env?: NodeJS.ProcessEnv; config?: unknown }) => {
        const runtimePluginConfig = resolvePluginConfigObject(ctx.config, CURSOR_PROVIDER_ID);
        const pluginConfig = runtimePluginConfig ?? (ctx.config ? undefined : options.pluginConfig);
        return await buildCursorProviderCatalog({
          env: ctx.env,
          pluginConfig,
          listModels: options.listModels,
        });
      },
    },
    staticCatalog: {
      order: "late",
      run: async () => ({
        provider: buildCursorProviderConfig(FALLBACK_CURSOR_MODELS),
      }),
    },
    resolveDynamicModel: (ctx: { modelId: string }) => resolveCursorDynamicModel(ctx.modelId),
    resolveSyntheticAuth: () => ({
      apiKey: CURSOR_SDK_AUTH_MARKER,
      source: "cursor-sdk",
      mode: "token",
    }),
    resolveThinkingProfile: ({
      modelId,
      compat,
    }: {
      modelId: string;
      compat?: unknown;
    }) => {
      const efforts = resolveCursorThinkingEfforts({
        modelId,
        supportedReasoningEfforts: readCursorSupportedReasoningEfforts(compat),
      });
      return {
        levels: [
          { id: "off" as const },
          ...efforts.map((id) => ({ id: id as "low" | "medium" | "high" | "xhigh" | "minimal" })),
        ],
      };
    },
    resolveSystemPromptContribution: ({
      config,
      modelId,
    }: {
      config?: unknown;
      modelId?: string;
    }) => resolveCursorSystemPromptContribution({ config, modelId }),
  };
}

/** Builds a provider catalog from live discovery or the offline fallback. */
export async function buildCursorProviderCatalog(
  options: BuildCatalogOptions = {},
): Promise<{ provider: ModelProviderConfig }> {
  const pluginConfig = readCursorPluginConfig(options.pluginConfig);
  const env = options.env ?? process.env;
  const liveForced = env[LIVE_DISCOVERY_ENV] === "1";
  if (!pluginConfig.discovery.enabled && !liveForced) {
    return { provider: buildCursorProviderConfig(mergeCursorCatalogModels([])) };
  }

  try {
    const auth = resolveCursorApiKey({ pluginConfig, env });
    const models = mergeCursorCatalogModels(
      await (options.listModels ?? listCursorModelsViaSdk)({
        apiKey: auth.apiKey,
        timeoutMs: pluginConfig.discovery.timeoutMs,
      }),
    );
    if (models.length === 0) {
      return { provider: buildCursorProviderConfig(mergeCursorCatalogModels([])) };
    }
    return { provider: buildCursorProviderConfig(models) };
  } catch (error) {
    cursorCatalogLog.warn?.(
      `cursor catalog discovery failed; using fallback models: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { provider: buildCursorProviderConfig(mergeCursorCatalogModels([])) };
  }
}

async function listCursorModelsViaSdk(options: {
  apiKey: string;
  timeoutMs: number;
}): Promise<CursorCatalogModel[]> {
  const { Cursor } = await import("@cursor/sdk");
  const listed = await Promise.race([
    Cursor.models.list({ apiKey: options.apiKey }),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Cursor.models.list timed out after ${options.timeoutMs}ms`)),
        options.timeoutMs,
      );
    }),
  ]);

  if (!Array.isArray(listed)) {
    return [];
  }

  const models: CursorCatalogModel[] = [];
  for (const entry of listed as unknown[]) {
    let id = "";
    let displayName: string | undefined;
    let parameters: Array<{ id?: string; values?: unknown[] }> = [];
    if (typeof entry === "string") {
      id = entry.trim();
      displayName = id;
    } else if (entry && typeof entry === "object") {
      const record = entry as {
        id?: unknown;
        displayName?: unknown;
        parameters?: unknown;
      };
      id = typeof record.id === "string" ? record.id.trim() : "";
      displayName = typeof record.displayName === "string" ? record.displayName : id;
      parameters = Array.isArray(record.parameters)
        ? (record.parameters as Array<{ id?: string; values?: unknown[] }>)
        : [];
    }
    if (!id) {
      continue;
    }
    const catalogId = normalizeCursorCatalogModelId(id);
    const reasoningParam = parameters.find(
      (param) => param.id === "reasoning" || param.id === "effort",
    );
    const supportedReasoningEfforts = Array.isArray(reasoningParam?.values)
      ? reasoningParam.values
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
      : undefined;
    models.push({
      id: catalogId,
      model: catalogId,
      displayName:
        catalogId === "auto" && id === "default"
          ? (displayName && displayName !== "default" ? displayName : "Auto")
          : (displayName ?? catalogId),
      inputModalities: ["text", "image"],
      ...(supportedReasoningEfforts ? { supportedReasoningEfforts } : {}),
    });
  }
  return models;
}

function resolveCursorDynamicModel(modelId: string): ProviderRuntimeModel | null {
  const id = modelId.trim();
  if (!id) {
    return null;
  }
  const known = FALLBACK_CURSOR_MODELS.find((model) => model.id === id || model.model === id);
  const definition = buildCursorModelDefinition(
    known ?? {
      id,
      model: id,
      inputModalities: ["text", "image"],
    },
  );
  return normalizeModelCompat({
    ...definition,
    provider: CURSOR_PROVIDER_ID,
    baseUrl: buildCursorProviderConfig(FALLBACK_CURSOR_MODELS).baseUrl,
  }) as ProviderRuntimeModel;
}

function readCursorSupportedReasoningEfforts(compat: unknown): string[] | undefined {
  if (!compat || typeof compat !== "object") {
    return undefined;
  }
  const value = (compat as { supportedReasoningEfforts?: unknown }).supportedReasoningEfforts;
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveCursorThinkingEfforts(params: {
  modelId: string;
  supportedReasoningEfforts?: string[];
}): string[] {
  if (params.supportedReasoningEfforts && params.supportedReasoningEfforts.length > 0) {
    return params.supportedReasoningEfforts;
  }
  const lower = params.modelId.toLowerCase();
  if (lower.includes("composer") || lower === "auto") {
    return ["low", "medium", "high"];
  }
  return [];
}
