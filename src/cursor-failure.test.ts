import { describe, expect, it } from "vitest";
import { CursorAgentError } from "@cursor/sdk";
import { buildCursorFailure, promptErrorFromCursorFailure } from "./cursor-failure.js";

describe("buildCursorFailure", () => {
  it("merges run error, stream error, and correlation ids", () => {
    const failure = buildCursorFailure({
      kind: "run_error",
      runResult: {
        id: "run-1",
        requestId: "req-9",
        status: "error",
        error: { message: "local agent exited", code: "agent_crashed" },
      },
      streamError: new Error("status event failed"),
      cursorAgentId: "agent-abc",
    });

    expect(failure.message).toContain("local agent exited");
    expect(failure.message).toContain("runId=run-1");
    expect(failure.message).toContain("requestId=req-9");
    expect(failure.message).toContain("agentId=agent-abc");
    expect(failure.message).toContain("code=agent_crashed");
    expect(failure.streamError).toBe("status event failed");
  });

  it("uses sdk error json for caught CursorAgentError", () => {
    const failure = buildCursorFailure({
      kind: "cursor_agent_error",
      caught: new CursorAgentError("auth failed", { code: "unauthorized", status: 401 }),
    });

    expect(failure.message).toContain("auth failed");
    expect(failure.sdkError).toMatchObject({ code: "unauthorized", status: 401 });
  });

  it("attaches cursorFailure on prompt errors", () => {
    const failure = buildCursorFailure({
      kind: "attempt_failed",
      caught: new Error("boom"),
    });
    const promptError = promptErrorFromCursorFailure(failure, new Error("boom"));
    expect(promptError.code).toBe("attempt_failed");
    expect(promptError.cursorFailure?.message).toContain("boom");
  });
});
