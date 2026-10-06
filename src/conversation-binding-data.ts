/**
 * Opaque conversation-binding payload stored by the OpenClaw host.
 */
import { randomUUID } from "node:crypto";

export const CURSOR_CONVERSATION_BINDING_KIND = "cursor-sdk-session" as const;
export const CURSOR_CONVERSATION_BINDING_VERSION = 1 as const;

export type CursorConversationSource = {
  agentId: string;
  sessionId: string;
  cursorAgentId: string;
  sessionKey?: string;
};

export type CursorConversationStart = {
  id: string;
  cursorAgentId?: string;
  model?: string;
};

export type CursorConversationBindingData = {
  kind: typeof CURSOR_CONVERSATION_BINDING_KIND;
  version: typeof CURSOR_CONVERSATION_BINDING_VERSION;
  bindingId: string;
  workspaceDir: string;
  agentId?: string;
  source?: CursorConversationSource;
  start?: CursorConversationStart;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readSource(value: unknown): CursorConversationSource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const agentId = readString(record.agentId);
  const sessionId = readString(record.sessionId);
  const cursorAgentId = readString(record.cursorAgentId);
  if (!agentId || !sessionId || !cursorAgentId) {
    return undefined;
  }
  return {
    agentId,
    sessionId,
    cursorAgentId,
    ...(readString(record.sessionKey) ? { sessionKey: readString(record.sessionKey) } : {}),
  };
}

function readStart(value: unknown): CursorConversationStart | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = readString(record.id);
  if (!id) {
    return undefined;
  }
  return {
    id,
    ...(readString(record.cursorAgentId)
      ? { cursorAgentId: readString(record.cursorAgentId) }
      : {}),
    ...(readString(record.model) ? { model: readString(record.model) } : {}),
  };
}

/** Builds host-persisted conversation binding data for `/cursor bind`. */
export function createCursorConversationBindingData(params: {
  bindingId?: string;
  workspaceDir: string;
  agentId?: string;
  source?: CursorConversationSource;
  start?: CursorConversationStart;
}): CursorConversationBindingData {
  return {
    kind: CURSOR_CONVERSATION_BINDING_KIND,
    version: CURSOR_CONVERSATION_BINDING_VERSION,
    bindingId: params.bindingId?.trim() || randomUUID(),
    workspaceDir: params.workspaceDir.trim() || process.cwd(),
    ...(params.agentId?.trim() ? { agentId: params.agentId.trim() } : {}),
    ...(params.source ? { source: params.source } : {}),
    ...(params.start ? { start: params.start } : {}),
  };
}

/** Reads Cursor conversation binding data from a host binding record. */
export function readCursorConversationBindingData(
  binding: { data?: unknown } | null | undefined,
): CursorConversationBindingData | undefined {
  const data = binding?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  return readCursorConversationBindingDataRecord(data as Record<string, unknown>);
}

/** Parses a raw binding data object. */
export function readCursorConversationBindingDataRecord(
  data: Record<string, unknown>,
): CursorConversationBindingData | undefined {
  if (data.kind !== CURSOR_CONVERSATION_BINDING_KIND) {
    return undefined;
  }
  if (data.version !== CURSOR_CONVERSATION_BINDING_VERSION) {
    return undefined;
  }
  const bindingId = readString(data.bindingId);
  const workspaceDir = readString(data.workspaceDir);
  if (!bindingId || !workspaceDir) {
    return undefined;
  }
  return {
    kind: CURSOR_CONVERSATION_BINDING_KIND,
    version: CURSOR_CONVERSATION_BINDING_VERSION,
    bindingId,
    workspaceDir,
    ...(readString(data.agentId) ? { agentId: readString(data.agentId) } : {}),
    ...(readSource(data.source) ? { source: readSource(data.source) } : {}),
    ...(readStart(data.start) ? { start: readStart(data.start) } : {}),
  };
}

/** Default workspace for conversation binds when `--cwd` is omitted. */
export function resolveCursorDefaultWorkspaceDir(pluginConfig?: unknown): string {
  if (pluginConfig && typeof pluginConfig === "object" && !Array.isArray(pluginConfig)) {
    const local = (pluginConfig as { local?: { cwd?: unknown } }).local;
    const cwd = readString(local?.cwd);
    if (cwd) {
      return cwd;
    }
  }
  return process.cwd();
}
