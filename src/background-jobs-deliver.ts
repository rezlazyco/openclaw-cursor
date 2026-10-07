/**
 * Best-effort outbound delivery for background-job completion (all channel types).
 */
import { randomUUID } from "node:crypto";
import type { BackgroundJobNotifyContext } from "./background-jobs.js";
import { getBackgroundJobWorkflowHooks } from "./background-jobs-workflow.js";

type AnyTool = {
  name?: string;
  execute?: (id: string, args: unknown) => Promise<unknown>;
};

async function loadOpenClawTools(
  ctx: BackgroundJobNotifyContext,
): Promise<AnyTool[] | undefined> {
  try {
    const { createOpenClawCodingTools } = await import("openclaw/plugin-sdk/agent-harness");
    const created = await createOpenClawCodingTools({
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
      workspaceDir: ctx.workspaceDir,
      cwd: ctx.cwd ?? ctx.workspaceDir,
      agentDir: ctx.agentDir,
      config: ctx.config,
      modelProvider: "cursor",
      messageProvider: ctx.messageProvider ?? ctx.messageChannel,
      agentAccountId: ctx.agentAccountId,
      messageTo: ctx.messageTo,
      messageThreadId: ctx.messageThreadId,
      senderIsOwner: ctx.senderIsOwner,
      senderId: ctx.senderId,
      senderName: ctx.senderName,
      senderUsername: ctx.senderUsername,
      groupId: ctx.groupId,
      groupChannel: ctx.groupChannel,
      groupSpace: ctx.groupSpace,
    } as never);
    return Array.isArray(created) ? (created as AnyTool[]) : undefined;
  } catch {
    return undefined;
  }
}

function findTool(tools: AnyTool[], name: string): AnyTool | undefined {
  return tools.find((tool) => tool.name === name);
}

async function trySessionsSend(params: {
  tools: AnyTool[];
  sessionKey: string;
  text: string;
}): Promise<boolean> {
  const tool = findTool(params.tools, "sessions_send");
  if (!tool || typeof tool.execute !== "function") {
    return false;
  }
  const id = randomUUID();
  const attempts = [
    { sessionKey: params.sessionKey, message: params.text },
    { sessionKey: params.sessionKey, text: params.text },
    { to: params.sessionKey, message: params.text },
  ];
  for (const args of attempts) {
    try {
      await tool.execute(id, args);
      return true;
    } catch {
      // Try next arg shape.
    }
  }
  return false;
}

async function tryMessageSend(params: {
  tools: AnyTool[];
  ctx: BackgroundJobNotifyContext;
  text: string;
}): Promise<boolean> {
  const { isMessagingTool } = await import("openclaw/plugin-sdk/agent-harness-runtime");
  const tool = params.tools.find(
    (candidate) =>
      typeof candidate.name === "string" && isMessagingTool(candidate.name),
  );
  if (!tool || typeof tool.execute !== "function") {
    return false;
  }
  const args: Record<string, unknown> = {
    action: "send",
    text: params.text,
    message: params.text,
  };
  if (params.ctx.messageTo) {
    args.to = params.ctx.messageTo;
  }
  if (params.ctx.messageChannel) {
    args.channel = params.ctx.messageChannel;
    args.provider = params.ctx.messageChannel;
  }
  if (params.ctx.agentAccountId) {
    args.accountId = params.ctx.agentAccountId;
  }
  if (params.ctx.messageThreadId !== undefined) {
    args.threadId = params.ctx.messageThreadId;
  }
  try {
    await tool.execute(randomUUID(), args);
    return true;
  } catch {
    return false;
  }
}

async function tryScheduleAnnounce(params: {
  sessionKey: string;
  agentId?: string;
  text: string;
  jobId: string;
}): Promise<boolean> {
  const schedule = getBackgroundJobWorkflowHooks()?.scheduleSessionTurn;
  if (!schedule) {
    return false;
  }
  try {
    await schedule({
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      message: params.text,
      delayMs: 0,
      deliveryMode: "announce",
      tag: `cursor-bg-job-${params.jobId}`,
      deleteAfterRun: true,
    });
    return true;
  } catch {
    return false;
  }
}

/** Delivers a completion notice on the session's active channel (webchat, Telegram, etc.). */
export async function deliverBackgroundJobCompletion(params: {
  notifyContext?: BackgroundJobNotifyContext;
  sessionKey?: string;
  jobId: string;
  text: string;
}): Promise<void> {
  const ctx = params.notifyContext;
  const sessionKey = params.sessionKey ?? ctx?.sessionKey;
  if (!ctx?.sessionId && !sessionKey) {
    return;
  }

  const tools = ctx ? await loadOpenClawTools(ctx) : undefined;
  if (tools && sessionKey) {
    if (await trySessionsSend({ tools, sessionKey, text: params.text })) {
      return;
    }
  }

  if (tools && ctx) {
    if (await tryMessageSend({ tools, ctx, text: params.text })) {
      return;
    }
  }

  if (sessionKey) {
    await tryScheduleAnnounce({
      sessionKey,
      agentId: ctx?.agentId,
      text: params.text,
      jobId: params.jobId,
    });
  }
}
