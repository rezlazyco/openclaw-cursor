/**
 * Mirrors Cursor harness messages into the OpenClaw session transcript.
 * Pattern mirrors extensions/copilot/src/dual-write-transcripts.ts.
 */
import { createHash } from "node:crypto";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";

type MirroredAgentMessage = AgentMessage & {
  role: "user" | "assistant" | "toolResult";
};

const MIRROR_IDENTITY_META_KEY = "mirrorIdentity" as const;

export function attachCursorMirrorIdentity<T extends AgentMessage>(
  message: T,
  identity: string,
): T {
  const record = message as unknown as Record<string, unknown>;
  const existing = record.__openclaw;
  const baseMeta =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return {
    ...record,
    __openclaw: { ...baseMeta, [MIRROR_IDENTITY_META_KEY]: identity },
  } as unknown as T;
}

function readMirrorIdentity(message: MirroredAgentMessage): string | undefined {
  const meta = message.__openclaw;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const id = (meta as Record<string, unknown>)[MIRROR_IDENTITY_META_KEY];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function fingerprintMirrorMessageContent(message: MirroredAgentMessage): string {
  const payload = JSON.stringify({ role: message.role, content: message.content });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function buildMirrorDedupeIdentity(message: MirroredAgentMessage): string {
  return (
    readMirrorIdentity(message) ?? `${message.role}:${fingerprintMirrorMessageContent(message)}`
  );
}

function readTranscriptIdempotencyKeys(events: unknown[]): Set<string> {
  const keys = new Set<string>();
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      continue;
    }
    const parsed = event as { message?: { idempotencyKey?: unknown } };
    if (typeof parsed.message?.idempotencyKey === "string") {
      keys.add(parsed.message.idempotencyKey);
    }
  }
  return keys;
}

export type MirrorCursorTranscriptParams = {
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  messages: AgentMessage[];
  idempotencyScope?: string;
  config?: unknown;
};

function isMirroredRole(message: AgentMessage): message is MirroredAgentMessage {
  return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

async function mirrorCursorTranscript(params: MirrorCursorTranscriptParams): Promise<void> {
  const { runAgentHarnessBeforeMessageWriteHook } = await import(
    "openclaw/plugin-sdk/agent-harness-runtime"
  );
  const { publishSessionTranscriptUpdateByIdentity, withSessionTranscriptWriteLock } =
    await import("openclaw/plugin-sdk/session-transcript-runtime");

  const messages = params.messages.filter(isMirroredRole);
  if (messages.length === 0) {
    return;
  }

  const sessionFile = params.sessionFile.trim();
  if (!sessionFile) {
    throw new Error("Cursor transcript mirror requires a sessionFile target");
  }

  const transcriptTarget = {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionFile,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey ?? "",
  };

  const didAppend = await withSessionTranscriptWriteLock(
    { ...transcriptTarget, config: params.config as never },
    async (transcript) => {
      let didAppendMessage = false;
      const existingIdempotencyKeys = readTranscriptIdempotencyKeys(await transcript.readEvents());
      for (const message of messages) {
        const dedupeIdentity = buildMirrorDedupeIdentity(message);
        const sourceIdempotencyKey = message.idempotencyKey;
        const sourceUserIdempotencyKey =
          message.role === "user" &&
          typeof sourceIdempotencyKey === "string" &&
          sourceIdempotencyKey.trim()
            ? sourceIdempotencyKey.trim()
            : undefined;
        const idempotencyKey =
          sourceUserIdempotencyKey ??
          (params.idempotencyScope ? `${params.idempotencyScope}:${dedupeIdentity}` : undefined);
        if (idempotencyKey && existingIdempotencyKeys.has(idempotencyKey)) {
          continue;
        }
        const transcriptMessage = {
          ...(message as Record<string, unknown>),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        } as AgentMessage;
        const nextMessage = runAgentHarnessBeforeMessageWriteHook({
          message: transcriptMessage,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
        });
        if (!nextMessage) {
          continue;
        }
        const messageToAppend = (
          idempotencyKey
            ? {
                ...(nextMessage as unknown as Record<string, unknown>),
                idempotencyKey,
              }
            : nextMessage
        ) as AgentMessage;
        const appended = await transcript.appendMessage({
          message: messageToAppend,
          idempotencyLookup: idempotencyKey ? "caller-checked" : "scan",
        });
        if (!appended) {
          continue;
        }
        didAppendMessage = true;
        if (idempotencyKey) {
          existingIdempotencyKeys.add(idempotencyKey);
        }
      }
      return didAppendMessage;
    },
  );

  if (didAppend) {
    await publishSessionTranscriptUpdateByIdentity({
      ...transcriptTarget,
      update: params.sessionKey ? { sessionKey: params.sessionKey } : undefined,
    });
  }
}

/** Best-effort dual-write; never throws into the attempt path. */
export async function dualWriteCursorTranscriptBestEffort(
  params: MirrorCursorTranscriptParams,
): Promise<void> {
  try {
    await mirrorCursorTranscript(params);
  } catch (error) {
    console.warn("[cursor-attempt] dual-write transcript mirror failed", error);
  }
}
