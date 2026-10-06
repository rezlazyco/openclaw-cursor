import { describe, expect, it } from "vitest";
import { buildCursorMcpServers, fingerprintCursorMcpServers } from "./mcp-bridge.js";

describe("buildCursorMcpServers", () => {
  it("projects stdio servers from OpenClaw mcp.servers", () => {
    const servers = buildCursorMcpServers({
      config: {
        mcp: {
          servers: {
            outlook: {
              command: "node",
              args: ["/opt/outlook-mcp/dist/index.js"],
              env: { TOKEN: "x" },
            },
          },
        },
      },
    });
    expect(servers).toEqual({
      outlook: {
        type: "stdio",
        command: "node",
        args: ["/opt/outlook-mcp/dist/index.js"],
        env: { TOKEN: "x" },
      },
    });
  });

  it("maps streamable-http to Cursor http transport", () => {
    const servers = buildCursorMcpServers({
      config: {
        mcp: {
          servers: {
            atlas: {
              transport: "streamable-http",
              url: "https://atlas.example.com/mcp",
              headers: { Authorization: "Bearer t" },
            },
          },
        },
      },
    });
    expect(servers).toEqual({
      atlas: {
        type: "http",
        url: "https://atlas.example.com/mcp",
        headers: { Authorization: "Bearer t" },
      },
    });
  });

  it("skips disabled and oauth-without-headers servers", () => {
    const servers = buildCursorMcpServers({
      config: {
        mcp: {
          servers: {
            off: { enabled: false, command: "node", args: ["a.js"] },
            oauthOnly: {
              transport: "streamable-http",
              url: "https://example.com/mcp",
              auth: "oauth",
            },
            ok: { command: "uvx", args: ["server"] },
          },
        },
      },
    });
    expect(servers).toEqual({
      ok: { type: "stdio", command: "uvx", args: ["server"] },
    });
  });

  it("filters by cursor.agents when present", () => {
    const servers = buildCursorMcpServers({
      agentId: "main",
      config: {
        mcp: {
          servers: {
            forMain: {
              command: "node",
              args: ["main.js"],
              cursor: { agents: ["main"] },
            },
            forOther: {
              command: "node",
              args: ["other.js"],
              cursor: { agents: ["other"] },
            },
          },
        },
      },
    });
    expect(Object.keys(servers ?? {})).toEqual(["forMain"]);
  });

  it("fingerprints projected servers stably", () => {
    const servers = {
      b: { type: "stdio" as const, command: "b" },
      a: { type: "http" as const, url: "https://a.example" },
    };
    expect(fingerprintCursorMcpServers(servers)).toBe(
      "a=http:https://a.example|b=stdio:b:",
    );
  });
});
