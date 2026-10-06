/**
 * Cursor SDK operations backing `/cursor` diagnostics and agent management.
 */
import { Agent, Cursor } from "@cursor/sdk";
import { resolveCursorApiKey } from "./auth.js";
import { readCursorPluginConfig } from "./config.js";
import { resolveCursorDefaultWorkspaceDir } from "./conversation-binding-data.js";
import {
  buildCursorMcpServers,
  fingerprintCursorMcpServers,
} from "./mcp-bridge.js";
import {
  bindingStoreKey,
  lookupSessionBinding,
  registerCursorBinding,
  sessionBindingIdentity,
  type CursorBindingStore,
} from "./session-binding.js";
import { withCursorBindingLease } from "./binding-store.js";

export type CursorCommandOpsContext = {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  config?: unknown;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveWorkspace(pluginConfig: unknown): string {
  return resolveCursorDefaultWorkspaceDir(pluginConfig);
}

function listAgentsOptions(pluginConfig: ReturnType<typeof readCursorPluginConfig>, workspaceDir: string, apiKey: string) {
  if (pluginConfig.runtime === "cloud") {
    return { runtime: "cloud" as const, apiKey, limit: 15 };
  }
  return { runtime: "local" as const, cwd: workspaceDir, limit: 15 };
}

/** Lists recent Cursor agents for the configured runtime. */
export async function listCursorAgents(params: {
  pluginConfig?: unknown;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const pluginConfig = readCursorPluginConfig(params.pluginConfig);
  const workspaceDir = resolveWorkspace(params.pluginConfig);
  const auth = resolveCursorApiKey({ pluginConfig, env: params.env });
  const listed = await Agent.list(listAgentsOptions(pluginConfig, workspaceDir, auth.apiKey));
  if (listed.items.length === 0) {
    return `No Cursor agents found (${pluginConfig.runtime}, cwd=${workspaceDir}).`;
  }
  const lines = [`Cursor agents (${pluginConfig.runtime}):`];
  for (const item of listed.items) {
    const status = item.status ?? "unknown";
    const archived = item.archived ? " archived" : "";
    const cwd =
      "cwd" in item && typeof item.cwd === "string" && item.cwd ? ` cwd=${item.cwd}` : "";
    lines.push(
      `- ${item.agentId} | ${item.name || "(unnamed)"} | ${status}${archived}${cwd}`,
    );
    if (item.summary?.trim()) {
      lines.push(`  ${item.summary.trim()}`);
    }
  }
  if (listed.nextCursor) {
    lines.push(`(more available; next cursor=${listed.nextCursor})`);
  }
  return lines.join("\n");
}

/** Describes one Cursor agent and a short message preview. */
export async function describeCursorAgent(params: {
  agentId: string;
  pluginConfig?: unknown;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const agentId = params.agentId.trim();
  if (!agentId) {
    return "Usage: /cursor agent <agent-id>";
  }
  const pluginConfig = readCursorPluginConfig(params.pluginConfig);
  const workspaceDir = resolveWorkspace(params.pluginConfig);
  const auth = resolveCursorApiKey({ pluginConfig, env: params.env });
  const lines = [`Cursor agent ${agentId}:`];
  try {
    const info = await Agent.get(agentId, {
      apiKey: auth.apiKey,
      cwd: workspaceDir,
    });
    lines.push(`- Name: ${info.name || "(unnamed)"}`);
    lines.push(`- Status: ${info.status ?? "unknown"}`);
    if (info.summary?.trim()) {
      lines.push(`- Summary: ${info.summary.trim()}`);
    }
    if ("cwd" in info && typeof info.cwd === "string" && info.cwd) {
      lines.push(`- Cwd: ${info.cwd}`);
    }
  } catch (error) {
    lines.push(`- Metadata: unavailable (${error instanceof Error ? error.message : String(error)})`);
  }
  if (pluginConfig.runtime === "local") {
    try {
      const messages = await Agent.messages.list(agentId, {
        cwd: workspaceDir,
        limit: 5,
      });
      if (messages.length === 0) {
        lines.push("- Messages: (empty)");
      } else {
        lines.push("- Recent messages:");
        for (const entry of messages.slice(-5)) {
          const text =
            typeof entry.message === "string"
              ? entry.message
              : JSON.stringify(entry.message);
          const clipped = text.length > 160 ? `${text.slice(0, 160)}…` : text;
          lines.push(`  ${entry.type}: ${clipped}`);
        }
      }
    } catch (error) {
      lines.push(
        `- Messages: unavailable (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  return lines.join("\n");
}

/** Binds the active OpenClaw session to an existing Cursor agent id. */
export async function resumeCursorAgentToSession(params: {
  cursorAgentId: string;
  ctx: CursorCommandOpsContext;
  bindingStore: CursorBindingStore;
  pluginConfig?: unknown;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const cursorAgentId = params.cursorAgentId.trim();
  if (!cursorAgentId) {
    return "Usage: /cursor resume <agent-id>";
  }
  const sessionId = readString(params.ctx.sessionId);
  if (!sessionId) {
    return "Resume requires an active OpenClaw session.";
  }
  const pluginConfig = readCursorPluginConfig(params.pluginConfig);
  const workspaceDir = resolveWorkspace(params.pluginConfig);
  const auth = resolveCursorApiKey({ pluginConfig, env: params.env });
  const modelId = "composer-2.5";
  const mcpServers = buildCursorMcpServers({
    config: params.ctx.config,
    agentId: readString(params.ctx.agentId),
  });
  const mcpFingerprint = fingerprintCursorMcpServers(mcpServers);

  try {
    await Agent.get(cursorAgentId, {
      apiKey: auth.apiKey,
      cwd: workspaceDir,
    });
  } catch (error) {
    return `Could not find Cursor agent ${cursorAgentId}: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }

  const identity = sessionBindingIdentity({
    sessionId,
    sessionKey: readString(params.ctx.sessionKey),
    agentId: readString(params.ctx.agentId),
    config: params.ctx.config,
  });
  await withCursorBindingLease(params.bindingStore, identity, async () => {
    registerCursorBinding(params.bindingStore, bindingStoreKey(identity), {
      schemaVersion: 1,
      agentId: cursorAgentId,
      compatKey: [
        "provider=cursor",
        `model=${modelId}`,
        `cwd=${workspaceDir}`,
        `runtime=${pluginConfig.runtime}`,
        `auth=manual-resume`,
        `mcp=${mcpFingerprint ?? ""}`,
      ].join("|"),
      runtime: pluginConfig.runtime,
      sessionId,
      updatedAt: Date.now(),
    });
  });
  return `Bound this OpenClaw session to Cursor agent ${cursorAgentId}.`;
}

/** Lists models available to the authenticated Cursor account. */
export async function listCursorModels(params: {
  pluginConfig?: unknown;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const pluginConfig = readCursorPluginConfig(params.pluginConfig);
  const auth = resolveCursorApiKey({ pluginConfig, env: params.env });
  const models = await Cursor.models.list({ apiKey: auth.apiKey });
  if (models.length === 0) {
    return "No Cursor models returned.";
  }
  const lines = ["Cursor models:"];
  for (const model of models.slice(0, 25)) {
    const label = model.displayName?.trim() ? `${model.id} (${model.displayName})` : model.id;
    lines.push(`- ${label}`);
  }
  if (models.length > 25) {
    lines.push(`(${models.length - 25} more omitted)`);
  }
  return lines.join("\n");
}

/** Lists OpenClaw MCP servers projected into Cursor for this config. */
export function listProjectedMcpServers(params: {
  config?: unknown;
  agentId?: string;
}): string {
  const projected = buildCursorMcpServers({
    config: params.config,
    agentId: readString(params.agentId),
  });
  if (!projected || Object.keys(projected).length === 0) {
    return "No MCP servers are projected into Cursor for this config.";
  }
  const lines = ["MCP servers projected to Cursor:"];
  for (const name of Object.keys(projected).toSorted()) {
    const server = projected[name]!;
    const transport = "type" in server ? String(server.type) : "unknown";
    lines.push(`- ${name} (${transport})`);
  }
  lines.push(`Fingerprint: ${fingerprintCursorMcpServers(projected) ?? "(none)"}`);
  lines.push("Note: mcp.servers with auth=oauth and no headers are skipped.");
  return lines.join("\n");
}

/** Lists recent runs for a Cursor agent. */
export async function listCursorAgentRuns(params: {
  agentId: string;
  pluginConfig?: unknown;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const agentId = params.agentId.trim();
  if (!agentId) {
    return "Usage: /cursor runs <agent-id>";
  }
  const pluginConfig = readCursorPluginConfig(params.pluginConfig);
  const workspaceDir = resolveWorkspace(params.pluginConfig);
  const auth = resolveCursorApiKey({ pluginConfig, env: params.env });
  const runs = await Agent.listRuns(
    agentId,
    pluginConfig.runtime === "cloud"
      ? { runtime: "cloud", apiKey: auth.apiKey, limit: 10 }
      : { runtime: "local", cwd: workspaceDir, limit: 10 },
  );
  if (runs.items.length === 0) {
    return `No runs found for Cursor agent ${agentId}.`;
  }
  const lines = [`Runs for ${agentId}:`];
  for (const run of runs.items) {
    const model = run.model?.id ? ` model=${run.model.id}` : "";
    const duration = typeof run.durationMs === "number" ? ` ${run.durationMs}ms` : "";
    lines.push(`- ${run.id} | ${run.status}${model}${duration}`);
    if (run.error?.message) {
      lines.push(`  error: ${run.error.message}`);
    }
  }
  if (runs.nextCursor) {
    lines.push(`(more available; next cursor=${runs.nextCursor})`);
  }
  return lines.join("\n");
}

/** Builds a compact diagnostics report for `/cursor diagnostics`. */
export async function buildCursorDiagnostics(params: {
  ctx: CursorCommandOpsContext;
  bindingStore: CursorBindingStore;
  pluginConfig?: unknown;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const pluginConfig = readCursorPluginConfig(params.pluginConfig);
  const workspaceDir = resolveWorkspace(params.pluginConfig);
  const lines = [
    "Cursor diagnostics:",
    `- Runtime: ${pluginConfig.runtime}`,
    `- Workspace: ${workspaceDir}`,
    `- API key env: ${pluginConfig.apiKeyEnv}`,
  ];

  try {
    const auth = resolveCursorApiKey({ pluginConfig, env: params.env });
    lines.push(`- Auth: ${auth.source}`);
    try {
      const me = await Cursor.me({ apiKey: auth.apiKey });
      lines.push(`- API key name: ${me.apiKeyName}`);
      if (me.userEmail) {
        lines.push(`- User: ${me.userEmail}`);
      }
    } catch (error) {
      lines.push(
        `- Cursor.me: failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  } catch (error) {
    lines.push(`- Auth: missing (${error instanceof Error ? error.message : String(error)})`);
  }

  if (params.ctx.sessionId) {
    const identity = sessionBindingIdentity({
      sessionId: params.ctx.sessionId,
      sessionKey: readString(params.ctx.sessionKey),
      agentId: readString(params.ctx.agentId),
      config: params.ctx.config,
    });
    const binding = lookupSessionBinding(params.bindingStore, identity);
    lines.push(`- Session binding key: ${bindingStoreKey(identity)}`);
    lines.push(`- Bound Cursor agent: ${binding?.agentId ?? "(none)"}`);
  }

  lines.push("");
  lines.push(listProjectedMcpServers({
    config: params.ctx.config,
    agentId: readString(params.ctx.agentId),
  }));

  return lines.join("\n");
}
