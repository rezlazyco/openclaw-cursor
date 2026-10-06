/**
 * Bridges Cursor SDK stream events into OpenClaw partial-reply / agent events.
 */
import type { SDKMessage } from "@cursor/sdk";

export type CursorStreamBridgeState = {
  assistantTexts: string[];
  currentAssistantText: string;
  toolMetas: Array<{ toolName: string; meta?: string }>;
  streamError?: Error;
};

export type CursorStreamBridgeCallbacks = {
  onPartialReply?: (payload: { text?: string; delta?: string }) => void | Promise<void>;
  onAgentEvent?: (event: {
    stream: string;
    data: Record<string, unknown>;
  }) => void | Promise<void>;
};

export function createCursorStreamBridge(
  callbacks: CursorStreamBridgeCallbacks = {},
): {
  state: CursorStreamBridgeState;
  handleMessage: (event: SDKMessage) => Promise<void>;
  finalizeAssistantTexts: () => string[];
} {
  const state: CursorStreamBridgeState = {
    assistantTexts: [],
    currentAssistantText: "",
    toolMetas: [],
  };

  async function handleMessage(event: SDKMessage): Promise<void> {
    switch (event.type) {
      case "assistant": {
        let delta = "";
        const content = event.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
              const text = (block as { text?: unknown }).text;
              if (typeof text === "string" && text) {
                delta += text;
              }
            }
          }
        }
        if (!delta) {
          return;
        }
        state.currentAssistantText += delta;
        await callbacks.onPartialReply?.({
          text: state.currentAssistantText,
          delta,
        });
        await callbacks.onAgentEvent?.({
          stream: "assistant",
          data: { delta, text: state.currentAssistantText },
        });
        return;
      }
      case "thinking": {
        const text =
          typeof (event as { text?: unknown }).text === "string"
            ? (event as { text: string }).text
            : undefined;
        if (text) {
          await callbacks.onAgentEvent?.({
            stream: "thinking",
            data: { text },
          });
        }
        return;
      }
      case "tool_call": {
        const name =
          typeof (event as { name?: unknown }).name === "string"
            ? (event as { name: string }).name
            : "tool";
        const status =
          typeof (event as { status?: unknown }).status === "string"
            ? (event as { status: string }).status
            : undefined;
        state.toolMetas.push({
          toolName: name,
          ...(status ? { meta: status } : {}),
        });
        await callbacks.onAgentEvent?.({
          stream: "tool",
          data: {
            name,
            ...(status ? { status } : {}),
            callId: (event as { call_id?: unknown }).call_id,
          },
        });
        return;
      }
      case "status": {
        const status = (event as { status?: unknown }).status;
        const message = (event as { message?: unknown }).message;
        if (status === "error" || status === "failed") {
          const text =
            typeof message === "string" && message.trim()
              ? message
              : "Cursor run error";
          state.streamError = new Error(text);
        }
        await callbacks.onAgentEvent?.({
          stream: "status",
          data: {
            status,
            message,
          },
        });
        return;
      }
      default:
        return;
    }
  }

  function finalizeAssistantTexts(): string[] {
    const text = state.currentAssistantText.trim();
    if (text) {
      state.assistantTexts.push(text);
    }
    state.currentAssistantText = "";
    return [...state.assistantTexts];
  }

  return { state, handleMessage, finalizeAssistantTexts };
}
