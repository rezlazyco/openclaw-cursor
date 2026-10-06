import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readMcpOAuthAuthorizationHeader,
  resolveMcpOAuthStorePath,
  sanitizeMcpServerName,
} from "./mcp-oauth-bridge.js";
import { buildCursorMcpServers } from "./mcp-bridge.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function withStateDir(run: (stateDir: string) => void): void {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-oauth-"));
  tempDirs.push(stateDir);
  run(stateDir);
}

describe("mcp oauth bridge", () => {
  it("sanitizes server names like OpenClaw", () => {
    expect(sanitizeMcpServerName("my-server")).toBe("my-server");
    expect(sanitizeMcpServerName("9bad")).toMatch(/^mcp-/);
  });

  it("reads bearer tokens from the OpenClaw oauth store", () => {
    withStateDir((stateDir) => {
      const serverName = "atlas";
      const serverUrl = "https://example.com/mcp";
      const storePath = resolveMcpOAuthStorePath(serverName, serverUrl, {
        OPENCLAW_STATE_DIR: stateDir,
      });
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(
        storePath,
        JSON.stringify({ tokens: { access_token: "secret-token", token_type: "Bearer" } }),
      );
      expect(
        readMcpOAuthAuthorizationHeader({
          serverName,
          serverUrl,
          env: { OPENCLAW_STATE_DIR: stateDir },
        }),
      ).toBe("Bearer secret-token");
    });
  });

  it("projects oauth MCP servers when tokens exist", () => {
    withStateDir((stateDir) => {
      const serverName = "atlas";
      const serverUrl = "https://example.com/mcp";
      const storePath = resolveMcpOAuthStorePath(serverName, serverUrl, {
        OPENCLAW_STATE_DIR: stateDir,
      });
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(
        storePath,
        JSON.stringify({ tokens: { access_token: "secret-token" } }),
      );
      const servers = buildCursorMcpServers({
        env: { OPENCLAW_STATE_DIR: stateDir },
        config: {
          mcp: {
            servers: {
              atlas: {
                transport: "streamable-http",
                url: serverUrl,
                auth: "oauth",
              },
            },
          },
        },
      });
      expect(servers?.atlas).toEqual({
        type: "http",
        url: serverUrl,
        headers: { Authorization: "Bearer secret-token" },
      });
    });
  });
});
