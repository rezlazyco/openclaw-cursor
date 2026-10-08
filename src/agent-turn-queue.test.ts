import { describe, expect, it } from "vitest";
import { enqueueAgentTurn } from "./agent-turn-queue.js";

describe("enqueueAgentTurn", () => {
  it("runs tasks for different keys in parallel", async () => {
    const order: string[] = [];
    await Promise.all([
      enqueueAgentTurn("a", async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 20));
        order.push("a-end");
      }),
      enqueueAgentTurn("b", async () => {
        order.push("b-start");
        await new Promise((r) => setTimeout(r, 5));
        order.push("b-end");
      }),
    ]);
    expect(order.indexOf("b-end")).toBeLessThan(order.indexOf("a-end"));
  });

  it("serializes tasks for the same key", async () => {
    const order: string[] = [];
    await Promise.all([
      enqueueAgentTurn("session-1", async () => {
        order.push("first-start");
        await new Promise((r) => setTimeout(r, 25));
        order.push("first-end");
      }),
      enqueueAgentTurn("session-1", async () => {
        order.push("second-start");
        order.push("second-end");
      }),
    ]);
    expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });
});
