/**
 * Owner tool for listing, inspecting, and attaching Cursor SDK agents.
 */
import { Agent } from "@cursor/sdk";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { resolveCursorApiKey } from "./auth.js";
import { withCursorBindingLease, type CursorBindingLeaseStore } from "./binding-store.js";
import { readCursorPluginConfig } from "./config.js";
import { resolveCursorDefaultWorkspaceDir } from "./conversation-binding-data.js";
import { buildCursorMcpServers, fingerprintCursorMcpServers } from "./mcp-bridge.js";
import {
  bindingStoreKey,
  registerCursorBinding,
  sessionBindingIdentity,
} from "./session-binding.js";

const ListParamsSchema = Type.Object(
  {
    action: Type.Literal("list"),
    cursor: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  },
  { additionalProperties: false },
);

const GetParamsSchema = Type.Object(
  {
    action: Type.Literal("get"),
    agent_id: Type.String(),
    include_messages: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const ResumeParamsSchema = Type.Object(
  {
    action: Type.Literal("resume"),
    agent_id: Type.String(),
    attach: Type.Optional(
      Type.Boolean({
        default: true,
        description: "Attach this Cursor agent to the current OpenClaw session harness.",
      }),
    ),
    model: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const CursorAgentsParamsSchema = Type.Union([
  ListParamsSchema,
  GetParamsSchema,
  ResumeParamsSchema,
]);

export type CursorAgentsToolOptions = {
  bindingStore: CursorBindingLeaseStore;
  context: OpenClawPluginToolContext;
  getPluginConfig: () => unknown;
  getConfig?: () => unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 50
    ? value
    : undefined;
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function resolveToolSession(context: OpenClawPluginToolContext): {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
} | undefined {
  const sessionId =
    typeof context.sessionId === "string" && context.sessionId.trim()
      ? context.sessionId.trim()
      : undefined;
  if (!sessionId) {
    return undefined;
  }
  const sessionKey =
    typeof context.sessionKey === "string" && context.sessionKey.trim()
      ? context.sessionKey.trim()
      : undefined;
  const agentId =
    typeof context.agentId === "string" && context.agentId.trim()
      ? context.agentId.trim()
      : undefined;
  return { sessionId, ...(sessionKey ? { sessionKey } : {}), ...(agentId ? { agentId } : {}) };
}

/** Creates the `cursor_agents` owner tool. */
export function createCursorAgentsTool(options: CursorAgentsToolOptions) {
  return {
    name: "cursor_agents",
    label: "Cursor Agents",
    description:
      "List, inspect, or attach Cursor SDK agents. Use resume+attach to point the current OpenClaw session harness at an existing Cursor agent.",
    parameters: CursorAgentsParamsSchema,
    async execute(_toolCallId: string, rawParams: unknown) {
      const params = asRecord(rawParams);
      const action = readStringParam(params, "action", { required: true, label: "action" });
      const pluginConfig = readCursorPluginConfig(options.getPluginConfig());
      const config = options.getConfig?.();
      const workspaceDir = resolveCursorDefaultWorkspaceDir(config ?? options.getPluginConfig());
      const auth = resolveCursorApiKey({ pluginConfig });
      const listOptions =
        pluginConfig.runtime === "cloud"
          ? { runtime: "cloud" as const, apiKey: auth.apiKey, limit: readLimit(params.limit) ?? 20 }
          : {
              runtime: "local" as const,
              cwd: workspaceDir,
              limit: readLimit(params.limit) ?? 20,
            };

      if (action === "list") {
        const cursor = readStringParam(params, "cursor");
        const listed = await Agent.list({
          ...listOptions,
          ...(cursor ? { cursor } : {}),
        });
        return jsonResult({
          runtime: pluginConfig.runtime,
          items: listed.items,
          nextCursor: listed.nextCursor,
        });
      }

      const agentId = readStringParam(params, "agent_id", { required: true, label: "agent_id" });
      if (!agentId) {
        throw new Error("agent_id is required");
      }
      if (action === "get") {
        const info = await Agent.get(agentId, {
          apiKey: auth.apiKey,
          cwd: workspaceDir,
        });
        const includeMessages = readBoolean(params.include_messages);
        const messages =
          includeMessages && pluginConfig.runtime === "local"
            ? await Agent.messages.list(agentId, { cwd: workspaceDir, limit: 20 })
            : undefined;
        return jsonResult({ agent: info, ...(messages ? { messages } : {}) });
      }

      if (action !== "resume") {
        throw new Error(`unsupported cursor_agents action: ${action}`);
      }

      await Agent.get(agentId, {
        apiKey: auth.apiKey,
        cwd: workspaceDir,
      });

      const attach = readBoolean(params.attach, true);
      const session = resolveToolSession(options.context);
      if (attach && !session) {
        throw new Error("cannot attach a Cursor agent without an active OpenClaw session");
      }

      let attached = false;
      if (attach && session) {
        const modelId = readStringParam(params, "model") ?? "composer-2.5";
        const mcpServers = buildCursorMcpServers({
          config,
          agentId: session.agentId,
        });
        const mcpFingerprint = fingerprintCursorMcpServers(mcpServers);
        const identity = sessionBindingIdentity({
          sessionId: session.sessionId,
          sessionKey: session.sessionKey,
          agentId: session.agentId,
          config,
        });
        await withCursorBindingLease(options.bindingStore, identity, async () => {
          registerCursorBinding(options.bindingStore, bindingStoreKey(identity), {
            schemaVersion: 1,
            agentId,
            compatKey: [
              "provider=cursor",
              `model=${modelId}`,
              `cwd=${workspaceDir}`,
              `runtime=${pluginConfig.runtime}`,
              `auth=cursor_agents`,
              `mcp=${mcpFingerprint ?? ""}`,
            ].join("|"),
            runtime: pluginConfig.runtime,
            sessionId: session.sessionId,
            updatedAt: Date.now(),
          });
        });
        attached = true;
      }

      return jsonResult({
        action,
        agentId,
        attached,
        bindingKey: attached && session
          ? bindingStoreKey(
              sessionBindingIdentity({
                sessionId: session.sessionId,
                sessionKey: session.sessionKey,
                agentId: session.agentId,
                config,
              }),
            )
          : undefined,
      });
    },
  };
}
