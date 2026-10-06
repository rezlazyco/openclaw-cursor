/**
 * Cursor provider catalog constants and model definition helpers.
 */
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

/** Provider id used by Cursor model refs. */
export const CURSOR_PROVIDER_ID = "cursor";
/** Synthetic base URL used to route Cursor SDK model requests. */
export const CURSOR_BASE_URL = "https://api.cursor.com";
/** Synthetic auth marker understood by Cursor SDK runtime paths. */
export const CURSOR_SDK_AUTH_MARKER = "cursor-sdk";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

export type CursorCatalogModel = {
  id: string;
  model: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  inputModalities: string[];
  supportedReasoningEfforts?: string[];
};

/** Offline fallback catalog used when live Cursor discovery is unavailable. */
export const FALLBACK_CURSOR_MODELS = [
  {
    id: "composer-2.5",
    model: "composer-2.5",
    displayName: "Composer 2.5",
    description: "Default Cursor agentic coding model.",
    isDefault: true,
    inputModalities: ["text", "image"],
    supportedReasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "auto",
    model: "auto",
    displayName: "Auto",
    description: "Let Cursor pick a model for the account.",
    inputModalities: ["text", "image"],
  },
] satisfies CursorCatalogModel[];

/** Normalizes Cursor API model ids to stable OpenClaw catalog ids. */
export function normalizeCursorCatalogModelId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) {
    return trimmed;
  }
  return trimmed === "default" ? "auto" : trimmed;
}

/**
 * Merges live-discovered Cursor models with offline fallback entries.
 * Fallback metadata is preserved when discovery omits a known model (e.g. auto).
 */
export function mergeCursorCatalogModels(
  discovered: readonly CursorCatalogModel[],
  supplemental: readonly CursorCatalogModel[] = FALLBACK_CURSOR_MODELS,
): CursorCatalogModel[] {
  const byId = new Map<string, CursorCatalogModel>();

  for (const model of supplemental) {
    const id = normalizeCursorCatalogModelId(model.id);
    if (!id) {
      continue;
    }
    byId.set(id, { ...model, id, model: normalizeCursorCatalogModelId(model.model) || id });
  }

  for (const model of discovered) {
    const id = normalizeCursorCatalogModelId(model.id);
    if (!id) {
      continue;
    }
    const existing = byId.get(id);
    byId.set(id, {
      ...(existing ?? {
        id,
        model: id,
        inputModalities: ["text", "image"] as string[],
      }),
      ...model,
      id,
      model: id,
      displayName: model.displayName?.trim() || existing?.displayName || id,
      inputModalities:
        model.inputModalities.length > 0
          ? model.inputModalities
          : (existing?.inputModalities ?? ["text", "image"]),
    });
  }

  const ordered: CursorCatalogModel[] = [];
  const seen = new Set<string>();
  for (const model of discovered) {
    const id = normalizeCursorCatalogModelId(model.id);
    if (!id || seen.has(id)) {
      continue;
    }
    const merged = byId.get(id);
    if (merged) {
      ordered.push(merged);
      seen.add(id);
    }
  }
  for (const model of supplemental) {
    const id = normalizeCursorCatalogModelId(model.id);
    if (!id || seen.has(id)) {
      continue;
    }
    const merged = byId.get(id);
    if (merged) {
      ordered.push(merged);
      seen.add(id);
    }
  }
  for (const [id, model] of byId) {
    if (!seen.has(id)) {
      ordered.push(model);
    }
  }
  return ordered;
}

/**
 * Converts a Cursor model record into OpenClaw provider model config.
 */
export function buildCursorModelDefinition(model: {
  id: string;
  model: string;
  displayName?: string;
  inputModalities: string[];
  supportedReasoningEfforts?: string[];
}): ModelDefinitionConfig {
  const id = model.id.trim() || model.model.trim();
  const supportedReasoningEfforts = model.supportedReasoningEfforts;
  return {
    id,
    name: model.displayName?.trim() || id,
    api: "openai-completions",
    reasoning:
      supportedReasoningEfforts !== undefined
        ? supportedReasoningEfforts.length > 0
        : shouldDefaultToReasoningModel(id),
    input: model.inputModalities.includes("image") ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: {
      ...(supportedReasoningEfforts !== undefined
        ? { supportsReasoningEffort: supportedReasoningEfforts.length > 0 }
        : {}),
      ...(supportedReasoningEfforts && supportedReasoningEfforts.length > 0
        ? { supportedReasoningEfforts: [...supportedReasoningEfforts] }
        : {}),
      supportsUsageInStreaming: true,
    },
  };
}

/** Builds the synthetic Cursor provider config for a model list. */
export function buildCursorProviderConfig(models: CursorCatalogModel[]): ModelProviderConfig {
  return {
    baseUrl: CURSOR_BASE_URL,
    apiKey: CURSOR_SDK_AUTH_MARKER,
    auth: "token",
    api: "openai-completions",
    models: models.map(buildCursorModelDefinition),
  };
}

function shouldDefaultToReasoningModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return lower.includes("composer") || lower.includes("thinking") || lower === "auto";
}
