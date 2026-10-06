/**
 * Bridges OpenClaw tools into Cursor local customTools with messaging telemetry.
 */
import type { SDKCustomTool, SDKJsonValue } from "@cursor/sdk";
import type {
  AgentMessage,
  AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";

const CURSOR_OWNED_TOOL_NAMES = new Set([
  "exec",
  "bash",
  "process",
  "read",
  "write",
  "edit",
  "apply_patch",
  "apply-patch",
]);

export type CursorMessagingTarget = {
  tool: string;
  provider?: string;
  accountId?: string;
  to?: string;
  threadId?: string;
  text?: string;
  mediaUrls?: string[];
};

export type CursorToolTelemetry = {
  didSendViaMessagingTool: boolean;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: CursorMessagingTarget[];
  toolMetas: Array<{ toolName: string; meta?: string }>;
  toolMessages: AgentMessage[];
};

export type CursorToolBridge = {
  customTools: Record<string, SDKCustomTool>;
  telemetry: CursorToolTelemetry;
};

export type CursorToolBridgeOptions = {
  params: CursorToolBridgeParams;
  excludeToolNames?: readonly string[];
  agentId?: string;
  onToolCompleted?: (info: {
    toolName: string;
    toolCallId: string;
    args: Record<string, unknown>;
    result?: unknown;
    error?: string;
    startedAt: number;
  }) => void | Promise<void>;
};

/** Minimal OpenClaw runtime context needed to project tools into Cursor customTools. */
export type CursorToolBridgeParams = {
  disableTools?: boolean;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  sandboxSessionKey?: string;
  workspaceDir?: string;
  cwd?: string;
  agentDir?: string;
  config?: unknown;
  abortSignal?: AbortSignal;
  provider?: string;
  modelId?: string;
  runId?: string;
  messageProvider?: string;
  messageChannel?: string;
  agentAccountId?: string;
  messageTo?: string;
  messageThreadId?: string | number;
  toolsAllow?: string[];
  senderIsOwner?: boolean;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFirstString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function collectMediaUrls(args: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const single = readFirstString(args, ["mediaUrl", "media_url", "filePath", "path"]);
  if (single) {
    urls.push(single);
  }
  const list = args.mediaUrls ?? args.media_urls;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (typeof entry === "string" && entry.trim()) {
        urls.push(entry.trim());
      }
    }
  }
  return urls;
}

function toolResultToSdkResult(result: unknown): string | { content: Array<{ type: "text"; text: string }> } {
  if (typeof result === "string") {
    return result;
  }
  if (result && typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const texts = content
        .map((block) => {
          if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
            return typeof (block as { text?: unknown }).text === "string"
              ? (block as { text: string }).text
              : "";
          }
          return "";
        })
        .filter(Boolean);
      if (texts.length > 0) {
        return { content: texts.map((text) => ({ type: "text" as const, text })) };
      }
    }
    const details = (result as { details?: unknown }).details;
    if (details !== undefined) {
      try {
        return JSON.stringify({ ...(result as object), details }, null, 2);
      } catch {
        // fall through
      }
    }
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function toolResultToText(result: unknown): string {
  const mapped = toolResultToSdkResult(result);
  if (typeof mapped === "string") {
    return mapped;
  }
  return mapped.content.map((block) => block.text).join("\n");
}

function readToolSchema(tool: AnyAgentTool): Record<string, SDKJsonValue> | undefined {
  const candidate =
    (tool as { parameters?: unknown }).parameters ??
    (tool as { inputSchema?: unknown }).inputSchema ??
    (tool as { schema?: unknown }).schema;
  return isRecord(candidate) ? (candidate as Record<string, SDKJsonValue>) : undefined;
}

function createEmptyTelemetry(): CursorToolTelemetry {
  return {
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    toolMetas: [],
    toolMessages: [],
  };
}

async function recordMessagingTelemetry(params: {
  telemetry: CursorToolTelemetry;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  isError: boolean;
}): Promise<void> {
  try {
    const {
      extractMessagingToolSend,
      extractMessagingToolSendResult,
      isDeliveredMessagingToolResult,
      isMessagingTool,
      isMessagingToolSendAction,
    } = await import("openclaw/plugin-sdk/agent-harness-runtime");

    if (!isMessagingTool(params.toolName)) {
      return;
    }
    const isSend = isMessagingToolSendAction(params.toolName, params.args);
    const pending = extractMessagingToolSend(params.toolName, params.args);
    if (
      !isSend &&
      !isDeliveredMessagingToolResult({
        toolName: params.toolName,
        args: params.args,
        result: params.result,
        isError: params.isError,
      })
    ) {
      return;
    }
    params.telemetry.didSendViaMessagingTool = true;
    const text = readFirstString(params.args, ["text", "message", "body", "content"]);
    if (text) {
      params.telemetry.messagingToolSentTexts.push(text);
    }
    const mediaUrls = collectMediaUrls(params.args);
    params.telemetry.messagingToolSentMediaUrls.push(...mediaUrls);
    const targetBase = pending
      ? extractMessagingToolSendResult(pending, params.result)
      : {
          tool: params.toolName,
          provider: readFirstString(params.args, ["provider", "channel"]) ?? params.toolName,
          accountId: readFirstString(params.args, ["accountId", "account_id"]),
          to: readFirstString(params.args, ["to", "target", "recipient"]),
          threadId: readFirstString(params.args, ["threadId", "thread_id", "messageThreadId"]),
        };
    params.telemetry.messagingToolSentTargets.push({
      tool: params.toolName,
      provider: targetBase.provider,
      accountId: targetBase.accountId,
      to: targetBase.to,
      threadId:
        typeof targetBase.threadId === "string" || typeof targetBase.threadId === "number"
          ? String(targetBase.threadId)
          : undefined,
      ...(text ? { text } : {}),
      ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
    });
  } catch {
    // Messaging helpers may be unavailable in metadata-only loads; keep attempt alive.
    if (
      params.toolName === "message" ||
      params.toolName === "sessions_send" ||
      params.toolName.includes("message")
    ) {
      params.telemetry.didSendViaMessagingTool = true;
      const text = readFirstString(params.args, ["text", "message", "body", "content"]);
      if (text) {
        params.telemetry.messagingToolSentTexts.push(text);
      }
    }
  }
}

/**
 * Builds Cursor `local.customTools` plus messaging/tool telemetry for the attempt result.
 */
export async function buildCursorToolBridge(
  options: CursorToolBridgeOptions,
): Promise<CursorToolBridge | undefined> {
  if (options.params.disableTools === true) {
    return undefined;
  }

  let tools: AnyAgentTool[] = [];
  try {
    const { createOpenClawCodingTools } = await import("openclaw/plugin-sdk/agent-harness");
    const created = await createOpenClawCodingTools({
      agentId: options.params.agentId ?? options.agentId,
      sessionId: options.params.sessionId,
      sessionKey: options.params.sessionKey ?? options.params.sandboxSessionKey,
      workspaceDir: options.params.workspaceDir,
      cwd: options.params.cwd ?? options.params.workspaceDir,
      agentDir: options.params.agentDir,
      config: options.params.config,
      abortSignal: options.params.abortSignal,
      modelProvider: options.params.provider,
      modelId: options.params.modelId,
      runId: options.params.runId,
      messageProvider: options.params.messageProvider ?? options.params.messageChannel,
      agentAccountId: options.params.agentAccountId,
      messageTo: options.params.messageTo,
      messageThreadId: options.params.messageThreadId,
      toolsAllow: options.params.toolsAllow,
      senderIsOwner: options.params.senderIsOwner,
      senderId: options.params.senderId,
      senderName: options.params.senderName,
      senderUsername: options.params.senderUsername,
      groupId: options.params.groupId,
      groupChannel: options.params.groupChannel,
      groupSpace: options.params.groupSpace,
    } as never);
    if (!Array.isArray(created)) {
      return undefined;
    }
    tools = created as AnyAgentTool[];
  } catch {
    return undefined;
  }

  const exclude = new Set(
    [...CURSOR_OWNED_TOOL_NAMES, ...(options.excludeToolNames ?? [])].map((name) =>
      name.trim().toLowerCase(),
    ),
  );
  const telemetry = createEmptyTelemetry();
  const customTools: Record<string, SDKCustomTool> = {};

  for (const tool of tools) {
    const name = typeof tool.name === "string" ? tool.name.trim() : "";
    if (!name || exclude.has(name.toLowerCase())) {
      continue;
    }
    const description =
      typeof tool.description === "string" ? tool.description : `OpenClaw tool ${name}`;
    const inputSchema = readToolSchema(tool);
    customTools[name] = {
      description,
      ...(inputSchema ? { inputSchema } : {}),
      async execute(args, context) {
        const toolCallId =
          typeof context.toolCallId === "string" && context.toolCallId.trim()
            ? context.toolCallId.trim()
            : crypto.randomUUID();
        const startedAt = Date.now();
        const execute = tool.execute;
        if (typeof execute !== "function") {
          const error = `Tool ${name} has no execute handler`;
          telemetry.toolMetas.push({ toolName: name, meta: "error" });
          await options.onToolCompleted?.({
            toolName: name,
            toolCallId,
            args: args as Record<string, unknown>,
            error,
            startedAt,
          });
          return error;
        }

        try {
          const result = await execute(toolCallId, args as never, {
            abortSignal: options.params.abortSignal,
          } as never);
          telemetry.toolMetas.push({ toolName: name, meta: "ok" });
          telemetry.toolMessages.push({
            role: "toolResult",
            toolCallId,
            toolName: name,
            content: [{ type: "text", text: toolResultToText(result) }],
            timestamp: Date.now(),
          } as AgentMessage);
          await recordMessagingTelemetry({
            telemetry,
            toolName: name,
            args: args as Record<string, unknown>,
            result,
            isError: false,
          });
          await options.onToolCompleted?.({
            toolName: name,
            toolCallId,
            args: args as Record<string, unknown>,
            result,
            startedAt,
          });
          return toolResultToSdkResult(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          telemetry.toolMetas.push({ toolName: name, meta: "error" });
          telemetry.toolMessages.push({
            role: "toolResult",
            toolCallId,
            toolName: name,
            content: [{ type: "text", text: message }],
            isError: true,
            timestamp: Date.now(),
          } as AgentMessage);
          await options.onToolCompleted?.({
            toolName: name,
            toolCallId,
            args: args as Record<string, unknown>,
            error: message,
            startedAt,
          });
          return { content: [{ type: "text", text: message }], isError: true };
        }
      },
    };
  }

  if (Object.keys(customTools).length === 0) {
    return undefined;
  }
  return { customTools, telemetry };
}

/** @deprecated Use buildCursorToolBridge. */
export async function buildCursorCustomTools(
  options: CursorToolBridgeOptions,
): Promise<Record<string, SDKCustomTool> | undefined> {
  const bridge = await buildCursorToolBridge(options);
  return bridge?.customTools;
}
