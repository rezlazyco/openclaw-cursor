/**
 * Projects OpenClaw `mcp.servers` into Cursor SDK `mcpServers`.
 */
import type { McpServerConfig as CursorMcpServerConfig } from "@cursor/sdk";
import { readMcpOAuthAuthorizationHeader } from "./mcp-oauth-bridge.js";

export type OpenClawMcpServerLike = {
  enabled?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string | number | boolean>;
  cwd?: string;
  workingDirectory?: string;
  url?: string;
  transport?: "stdio" | "sse" | "streamable-http";
  headers?: Record<string, string | number | boolean>;
  auth?: "oauth" | unknown;
  cursor?: {
    agents?: string[];
  };
  [key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toStringRecord(
  value: Record<string, string | number | boolean> | undefined,
): Record<string, string> | undefined {
  if (!value) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      out[key] = String(entry);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeAgentId(value: string): string {
  return value.trim().toLowerCase();
}

function isServerAllowedForAgent(
  server: OpenClawMcpServerLike,
  agentId: string | undefined,
): boolean {
  const cursor = isRecord(server.cursor) ? server.cursor : undefined;
  if (!cursor || !Object.hasOwn(cursor, "agents")) {
    return true;
  }
  const agents = Array.isArray(cursor.agents)
    ? cursor.agents
        .filter((entry): entry is string => typeof entry === "string")
        .map(normalizeAgentId)
        .filter(Boolean)
    : [];
  if (agents.length === 0 || !agentId) {
    return false;
  }
  return agents.includes(normalizeAgentId(agentId));
}

function projectOneServer(
  server: OpenClawMcpServerLike,
  serverName?: string,
  processEnv?: NodeJS.ProcessEnv,
): CursorMcpServerConfig | undefined {
  if (server.enabled === false) {
    return undefined;
  }

  const command = readString(server.command);
  const url = readString(server.url);
  const transport = server.transport;
  const cwd = readString(server.cwd) ?? readString(server.workingDirectory);
  const env = toStringRecord(server.env);
  const headers = toStringRecord(server.headers);
  const args = Array.isArray(server.args)
    ? server.args.filter((entry): entry is string => typeof entry === "string")
    : undefined;

  const oauthHeaders =
    server.auth === "oauth" && url && serverName
      ? (() => {
          const authorization = readMcpOAuthAuthorizationHeader({
            serverName,
            serverUrl: url,
            env: processEnv,
          });
          return authorization ? { Authorization: authorization } : undefined;
        })()
      : undefined;
  const mergedHeaders =
    headers || oauthHeaders ? { ...oauthHeaders, ...headers } : undefined;

  // Stdio: command-based servers.
  if (command && (!transport || transport === "stdio") && !url) {
    return {
      type: "stdio",
      command,
      ...(args && args.length > 0 ? { args } : {}),
      ...(env ? { env } : {}),
      ...(cwd ? { cwd } : {}),
    };
  }

  // HTTP / SSE remote servers.
  if (url && (transport === "sse" || transport === "streamable-http" || transport === undefined)) {
    if (server.auth === "oauth" && !mergedHeaders?.Authorization) {
      return undefined;
    }
    const type = transport === "sse" ? "sse" : "http";
    return {
      type,
      url,
      ...(mergedHeaders ? { headers: mergedHeaders } : {}),
    };
  }

  // Explicit stdio even if url somehow present — prefer command.
  if (command) {
    return {
      type: "stdio",
      command,
      ...(args && args.length > 0 ? { args } : {}),
      ...(env ? { env } : {}),
      ...(cwd ? { cwd } : {}),
    };
  }

  return undefined;
}

/**
 * Builds Cursor SDK mcpServers from OpenClaw config.mcp.servers.
 * Returns undefined when nothing projectable is configured.
 */
export function buildCursorMcpServers(params: {
  config?: unknown;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
}): Record<string, CursorMcpServerConfig> | undefined {
  if (!isRecord(params.config)) {
    return undefined;
  }
  const mcp = params.config.mcp;
  if (!isRecord(mcp)) {
    return undefined;
  }
  const servers = mcp.servers;
  if (!isRecord(servers)) {
    return undefined;
  }

  const projected: Record<string, CursorMcpServerConfig> = {};
  for (const [name, raw] of Object.entries(servers)) {
    const serverName = name.trim();
    if (!serverName || !isRecord(raw)) {
      continue;
    }
    const server = raw as OpenClawMcpServerLike;
    if (!isServerAllowedForAgent(server, params.agentId)) {
      continue;
    }
    const mapped = projectOneServer(server, serverName, params.env);
    if (mapped) {
      projected[serverName] = mapped;
    }
  }

  return Object.keys(projected).length > 0 ? projected : undefined;
}

/** Stable fingerprint for compat-key invalidation when MCP set changes. */
export function fingerprintCursorMcpServers(
  servers: Record<string, CursorMcpServerConfig> | undefined,
): string {
  if (!servers) {
    return "";
  }
  const names = Object.keys(servers).toSorted();
  const parts = names.map((name) => {
    const server = servers[name];
    if ("command" in server) {
      return `${name}=stdio:${server.command}:${(server.args ?? []).join(" ")}`;
    }
    return `${name}=${server.type ?? "http"}:${server.url}`;
  });
  return parts.join("|");
}
