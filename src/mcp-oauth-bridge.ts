/**
 * Reads OpenClaw MCP OAuth tokens from the private state directory and
 * projects them into Cursor MCP HTTP headers.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type McpOAuthStore = {
  tokens?: {
    access_token?: string;
    token_type?: string;
  };
};

const TOOL_NAME_MAX_PREFIX = 30;

function resolveOpenClawStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".openclaw");
}

/** Mirrors OpenClaw's MCP server name sanitizer for oauth store filenames. */
export function sanitizeMcpServerName(raw: string): string {
  let cleaned = raw.trim().replace(/[^A-Za-z0-9_-]/g, "-") || "mcp";
  if (!/^[A-Za-z]/.test(cleaned)) {
    cleaned = `mcp-${cleaned}`;
  }
  return cleaned.length > TOOL_NAME_MAX_PREFIX
    ? cleaned.slice(0, TOOL_NAME_MAX_PREFIX)
    : cleaned;
}

/** Path to the persisted OAuth credential file for one MCP server URL. */
export function resolveMcpOAuthStorePath(
  serverName: string,
  serverUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const safeServerName = sanitizeMcpServerName(serverName);
  const key = createHash("sha256")
    .update(serverName)
    .update("\0")
    .update(serverUrl)
    .digest("hex");
  return path.join(
    resolveOpenClawStateDir(env),
    "mcp-oauth",
    `${safeServerName}-${key.slice(0, 16)}.json`,
  );
}

function readMcpOAuthStore(filePath: string): McpOAuthStore {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as McpOAuthStore;
  } catch {
    return {};
  }
}

/**
 * Returns an Authorization header value for an OAuth MCP server when OpenClaw
 * has stored tokens for that server name + URL pair.
 */
export function readMcpOAuthAuthorizationHeader(params: {
  serverName: string;
  serverUrl: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const filePath = resolveMcpOAuthStorePath(
    params.serverName,
    params.serverUrl,
    params.env,
  );
  const store = readMcpOAuthStore(filePath);
  const accessToken = store.tokens?.access_token;
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    return undefined;
  }
  const tokenType = store.tokens?.token_type;
  if (typeof tokenType === "string" && tokenType.trim() && tokenType.toLowerCase() !== "bearer") {
    return `${tokenType.trim()} ${accessToken.trim()}`;
  }
  return `Bearer ${accessToken.trim()}`;
}
