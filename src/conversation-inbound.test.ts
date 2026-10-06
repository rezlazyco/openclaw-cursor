import { describe, expect, it } from "vitest";
import { createCursorConversationBindingData } from "./conversation-binding-data.js";
import {
  buildConversationToolBridgeParams,
  extractInboundClaimImages,
} from "./conversation-inbound.js";

describe("conversation inbound helpers", () => {
  it("maps inbound claim context into tool-bridge params", () => {
    const data = createCursorConversationBindingData({
      bindingId: "bind-1",
      workspaceDir: "/tmp/ws",
      agentId: "main",
      start: { id: "s1", model: "composer-2.5" },
      source: {
        agentId: "main",
        sessionId: "sess-src",
        cursorAgentId: "agent-1",
        sessionKey: "agent:main:telegram:1",
      },
    });
    const params = buildConversationToolBridgeParams({
      data,
      event: {
        content: "hi",
        channel: "telegram",
        accountId: "acct-1",
        conversationId: "chat-1",
        threadId: 42,
        runId: "run-1",
        senderId: "user-1",
        senderIsOwner: true,
        sessionKey: "agent:main:telegram:1",
      },
      ctx: { agentId: "main" },
      config: { plugins: { entries: { cursor: { enabled: true } } } },
    });
    expect(params.sessionId).toBe("sess-src");
    expect(params.sessionKey).toBe("agent:main:telegram:1");
    expect(params.workspaceDir).toBe("/tmp/ws");
    expect(params.messageProvider).toBe("telegram");
    expect(params.messageThreadId).toBe(42);
    expect(params.modelId).toBe("composer-2.5");
  });

  it("extracts inbound images from metadata", () => {
    expect(
      extractInboundClaimImages({
        metadata: {
          mediaUrls: ["https://example.com/a.png"],
          mediaPaths: ["/tmp/a.jpg"],
        },
      }),
    ).toEqual([
      { url: "file:///tmp/a.jpg" },
      { url: "https://example.com/a.png" },
    ]);
  });
});
