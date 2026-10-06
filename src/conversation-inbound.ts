/**
 * Maps inbound_claim event/context into Cursor tool-bridge params and images.
 */
import type { SDKImage } from "@cursor/sdk";
import type { CursorToolBridgeParams } from "./tool-bridge.js";
import type { CursorConversationBindingData } from "./conversation-binding-data.js";

export type CursorInboundClaimEvent = {
  content?: string;
  body?: string;
  bodyForAgent?: string;
  commandAuthorized?: boolean;
  sessionKey?: string;
  senderIsOwner?: boolean;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  channel?: string;
  accountId?: string;
  conversationId?: string;
  threadId?: string | number;
  runId?: string;
  isGroup?: boolean;
  metadata?: Record<string, unknown>;
};

export type CursorInboundClaimContext = {
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  conversationId?: string;
  senderId?: string;
  pluginBinding?: { data?: unknown; bindingId?: string } | null;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Builds tool-bridge params for a bound channel conversation turn. */
export function buildConversationToolBridgeParams(params: {
  event: CursorInboundClaimEvent;
  ctx: CursorInboundClaimContext;
  data: CursorConversationBindingData;
  config?: unknown;
}): CursorToolBridgeParams {
  const sessionKey = readString(params.event.sessionKey) ?? readString(params.ctx.sessionKey);
  const sessionId =
    readString(params.data.source?.sessionId) ??
    readString(params.ctx.sessionId) ??
    `conversation:${params.data.bindingId}`;
  const metadata = params.event.metadata ?? {};
  const threadId = params.event.threadId;
  return {
    sessionId,
    ...(sessionKey ? { sessionKey } : {}),
    agentId: readString(params.data.agentId) ?? readString(params.ctx.agentId),
    workspaceDir: params.data.workspaceDir,
    cwd: params.data.workspaceDir,
    config: params.config,
    provider: "cursor",
    modelId: readString(params.data.start?.model),
    runId: readString(params.event.runId),
    messageChannel: readString(params.event.channel),
    messageProvider: readString(params.event.channel),
    agentAccountId: readString(params.event.accountId),
    messageTo:
      readString(metadata.to) ??
      readString(params.event.conversationId) ??
      readString(params.ctx.conversationId),
    ...(threadId !== undefined && threadId !== null ? { messageThreadId: threadId } : {}),
    senderIsOwner: params.event.senderIsOwner,
    senderId: readString(params.event.senderId) ?? readString(params.ctx.senderId),
    senderName: readString(params.event.senderName),
    senderUsername: readString(params.event.senderUsername),
    groupId: params.event.isGroup ? readString(params.event.conversationId) : null,
    groupChannel: params.event.isGroup ? readString(params.event.channel) : null,
  };
}

/** Extracts inbound channel images from hook metadata for Cursor SDK send(). */
export function extractInboundClaimImages(event: CursorInboundClaimEvent): SDKImage[] {
  const metadata = event.metadata ?? {};
  const paths = readStringList(metadata.mediaPaths).concat(readStringList(metadata.mediaPath));
  const urls = readStringList(metadata.mediaUrls).concat(readStringList(metadata.mediaUrl));
  const images: SDKImage[] = [];
  for (const path of paths) {
    images.push({ url: path.startsWith("file://") ? path : `file://${path}` });
  }
  for (const url of urls) {
    images.push({ url });
  }
  return images;
}
