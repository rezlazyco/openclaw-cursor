/**
 * `/cursor` plugin command: bind / detach / binding / status / help.
 */
import { randomUUID } from "node:crypto";
import {
  createCursorConversationBindingData,
  readCursorConversationBindingData,
  resolveCursorDefaultWorkspaceDir,
} from "./conversation-binding-data.js";
import {
  buildCursorDiagnostics,
  describeCursorAgent,
  listCursorAgentRuns,
  listCursorAgents,
  listCursorModels,
  listProjectedMcpServers,
  resumeCursorAgentToSession,
} from "./command-ops.js";
import {
  bindingStoreKey,
  conversationBindingIdentity,
  deleteCursorBinding,
  lookupCursorBinding,
  lookupSessionBinding,
  sessionBindingIdentity,
  type CursorBindingStore,
} from "./session-binding.js";
import { readCursorActiveRun, stopCursorActiveRun } from "./conversation-control.js";

export type CursorCommandContext = {
  args?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  config?: unknown;
  requestConversationBinding: (params: {
    summary: string;
    detachHint?: string;
    data: unknown;
  }) => Promise<
    | { status: "pending"; reply: { text?: string } }
    | { status: "error"; message: string }
    | { status: "bound" }
    | { status: string; reply?: { text?: string }; message?: string }
  >;
  detachConversationBinding: () => Promise<{ removed: boolean }>;
  getCurrentConversationBinding: () => Promise<{
    bindingId?: string;
    data?: unknown;
  } | null>;
};

export type CursorCommandResult = { text: string };

export type CursorCommandOptions = {
  bindingStore: CursorBindingStore;
  pluginConfig?: unknown;
  resolvePluginConfig?: () => unknown;
};

function splitArgs(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }
  return raw.trim().split(/\s+/);
}

function parseBindArgs(args: string[]): {
  help: boolean;
  cursorAgentId?: string;
  cwd?: string;
  model?: string;
} {
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true };
  }
  let cursorAgentId: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token === "--cwd" && args[i + 1]) {
      cwd = args[++i];
      continue;
    }
    if (token === "--model" && args[i + 1]) {
      model = args[++i];
      continue;
    }
    if (!token.startsWith("-") && !cursorAgentId) {
      cursorAgentId = token;
    }
  }
  return { help: false, cursorAgentId, cwd, model };
}

async function bindConversation(
  ctx: CursorCommandContext,
  options: CursorCommandOptions,
  args: string[],
): Promise<CursorCommandResult> {
  const parsed = parseBindArgs(args);
  if (parsed.help) {
    return {
      text: "Usage: /cursor bind [agent-id] [--cwd <path>] [--model <model>]",
    };
  }
  const pluginConfig = options.resolvePluginConfig?.() ?? options.pluginConfig;
  const workspaceDir = parsed.cwd ?? resolveCursorDefaultWorkspaceDir(pluginConfig);
  const currentConversation = await ctx.getCurrentConversationBinding();
  const currentData = readCursorConversationBindingData(currentConversation);
  const bindingId =
    currentData?.bindingId ??
    (currentConversation?.bindingId
      ? `conversation-${currentConversation.bindingId}`
      : undefined);

  let source:
    | {
        agentId: string;
        sessionId: string;
        cursorAgentId: string;
        sessionKey?: string;
      }
    | undefined;
  if (ctx.sessionId) {
    const identity = sessionBindingIdentity({
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
      agentId: ctx.agentId,
      config: ctx.config,
    });
    const sessionBinding = lookupSessionBinding(options.bindingStore, identity);
    if (sessionBinding) {
      source = {
        agentId: ctx.agentId?.trim() || "main",
        sessionId: ctx.sessionId,
        cursorAgentId: sessionBinding.agentId,
        ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
      };
    }
  }

  const data = createCursorConversationBindingData({
    bindingId,
    workspaceDir,
    agentId: ctx.agentId,
    source: currentData?.source ?? source,
    start: {
      id: randomUUID(),
      ...(parsed.cursorAgentId ? { cursorAgentId: parsed.cursorAgentId } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
    },
  });

  const label = parsed.cursorAgentId ?? "a new Cursor agent";
  const request = await ctx.requestConversationBinding({
    summary: `Cursor agent ${label} in ${workspaceDir}`,
    detachHint: "/cursor detach",
    data,
  });
  if (request.status === "pending") {
    return { text: request.reply?.text ?? "Conversation bind pending approval." };
  }
  if (request.status === "error") {
    return { text: request.message ?? "Conversation bind failed." };
  }
  return {
    text: `Bound this conversation to ${label} in ${workspaceDir}. The next message will initialize it.`,
  };
}

async function detachConversation(
  ctx: CursorCommandContext,
  options: CursorCommandOptions,
): Promise<CursorCommandResult> {
  const current = await ctx.getCurrentConversationBinding();
  const data = readCursorConversationBindingData(current);
  const detached = await ctx.detachConversationBinding();
  if (data) {
    deleteCursorBinding(
      options.bindingStore,
      bindingStoreKey(conversationBindingIdentity(data.bindingId)),
    );
  }
  return {
    text: detached.removed
      ? "Detached this conversation from Cursor."
      : "No Cursor conversation binding was attached.",
  };
}

async function describeBinding(
  ctx: CursorCommandContext,
  options: CursorCommandOptions,
): Promise<CursorCommandResult> {
  const current = await ctx.getCurrentConversationBinding();
  const data = readCursorConversationBindingData(current);
  if (!current || !data) {
    return { text: "No Cursor conversation binding is attached." };
  }
  const stored = lookupCursorBinding(
    options.bindingStore,
    bindingStoreKey(conversationBindingIdentity(data.bindingId)),
  );
  return {
    text: [
      "Cursor conversation binding:",
      `- Binding id: ${data.bindingId}`,
      `- Workspace: ${data.workspaceDir}`,
      `- Cursor agent: ${stored?.agentId ?? data.start?.cursorAgentId ?? data.source?.cursorAgentId ?? "(not initialized yet)"}`,
      `- Model hint: ${data.start?.model ?? "composer-2.5"}`,
      `- Runtime: ${stored?.runtime ?? "unknown"}`,
    ].join("\n"),
  };
}

function statusText(
  ctx: CursorCommandContext,
  options: CursorCommandOptions,
): CursorCommandResult {
  const pluginConfig = options.resolvePluginConfig?.() ?? options.pluginConfig;
  const lines = [
    "Cursor plugin status:",
    `- Workspace default: ${resolveCursorDefaultWorkspaceDir(pluginConfig)}`,
    "- Harness: cursor (Agent.create / resume / send)",
    "- Conversation bind: /cursor bind",
    "- Stop: /cursor stop (run.cancel); steer is not supported by Cursor SDK",
  ];
  if (ctx.sessionId) {
    const identity = sessionBindingIdentity({
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
      agentId: ctx.agentId,
      config: ctx.config,
    });
    const key = bindingStoreKey(identity);
    const stored = lookupCursorBinding(options.bindingStore, key);
    const active = readCursorActiveRun(key);
    lines.push(`- Session binding key: ${key}`);
    lines.push(`- Bound agent: ${stored?.agentId ?? "(none)"}`);
    lines.push(`- Active run: ${active ? active.runId : "(none)"}`);
  }
  return { text: lines.join("\n") };
}

async function stopActive(
  ctx: CursorCommandContext,
  options: CursorCommandOptions,
): Promise<CursorCommandResult> {
  const current = await ctx.getCurrentConversationBinding();
  const data = readCursorConversationBindingData(current);
  if (data) {
    const result = await stopCursorActiveRun(
      bindingStoreKey(conversationBindingIdentity(data.bindingId)),
    );
    return { text: result.message };
  }
  if (!ctx.sessionId) {
    return { text: "No active Cursor conversation or session to stop." };
  }
  const identity = sessionBindingIdentity({
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
    config: ctx.config,
  });
  const result = await stopCursorActiveRun(bindingStoreKey(identity));
  return { text: result.message };
}

function helpText(): CursorCommandResult {
  return {
    text: [
      "Cursor commands:",
      "  /cursor bind [agent-id] [--cwd <path>] [--model <model>]",
      "  /cursor detach",
      "  /cursor binding",
      "  /cursor resume <agent-id>",
      "  /cursor agents | threads",
      "  /cursor agent <agent-id>",
      "  /cursor runs <agent-id>",
      "  /cursor models",
      "  /cursor mcp",
      "  /cursor diagnostics",
      "  /cursor stop",
      "  /cursor status",
      "  /cursor help",
    ].join("\n"),
  };
}

/** Creates the `/cursor` plugin command definition. */
export function createCursorCommand(
  options: CursorCommandOptions,
  opts?: { reservedOwnership?: boolean },
): {
  name: string;
  description: string;
  ownership?: "reserved";
  acceptsArgs: boolean;
  requireAuth: boolean;
  handler: (ctx: CursorCommandContext) => Promise<CursorCommandResult>;
} {
  return {
    name: "cursor",
    description: "Inspect and control the Cursor SDK harness / conversation binds",
    ...(opts?.reservedOwnership ? { ownership: "reserved" as const } : {}),
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => handleCursorCommand(ctx, options),
  };
}

/** Dispatches `/cursor` subcommands. */
export async function handleCursorCommand(
  ctx: CursorCommandContext,
  options: CursorCommandOptions,
): Promise<CursorCommandResult> {
  try {
    const [verb, ...rest] = splitArgs(ctx.args);
    switch ((verb ?? "help").toLowerCase()) {
      case "bind":
        return await bindConversation(ctx, options, rest);
      case "detach":
        return await detachConversation(ctx, options);
      case "binding":
        return await describeBinding(ctx, options);
      case "stop":
        return await stopActive(ctx, options);
      case "status":
        return statusText(ctx, options);
      case "agents":
      case "threads":
        return { text: await listCursorAgents({ pluginConfig: options.resolvePluginConfig?.() ?? options.pluginConfig }) };
      case "agent":
        return {
          text: await describeCursorAgent({
            agentId: rest[0] ?? "",
            pluginConfig: options.resolvePluginConfig?.() ?? options.pluginConfig,
          }),
        };
      case "resume":
        return {
          text: await resumeCursorAgentToSession({
            cursorAgentId: rest[0] ?? "",
            ctx,
            bindingStore: options.bindingStore,
            pluginConfig: options.resolvePluginConfig?.() ?? options.pluginConfig,
          }),
        };
      case "runs":
        return {
          text: await listCursorAgentRuns({
            agentId: rest[0] ?? "",
            pluginConfig: options.resolvePluginConfig?.() ?? options.pluginConfig,
          }),
        };
      case "models":
        return { text: await listCursorModels({ pluginConfig: options.resolvePluginConfig?.() ?? options.pluginConfig }) };
      case "mcp":
        return {
          text: listProjectedMcpServers({
            config: ctx.config,
            agentId: ctx.agentId,
          }),
        };
      case "diagnostics":
        return {
          text: await buildCursorDiagnostics({
            ctx,
            bindingStore: options.bindingStore,
            pluginConfig: options.resolvePluginConfig?.() ?? options.pluginConfig,
          }),
        };
      case "help":
      default:
        return helpText();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: `Cursor command failed: ${message}` };
  }
}
