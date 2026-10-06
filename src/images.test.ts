import { describe, expect, it } from "vitest";
import { toCursorSdkImages } from "./images.js";

describe("toCursorSdkImages", () => {
  it("maps OpenClaw image content to SDK images", () => {
    expect(
      toCursorSdkImages([
        { type: "image", data: "abc", mimeType: "image/jpeg" },
        { url: "https://example.com/a.png" },
        { type: "text", text: "nope" },
      ]),
    ).toEqual([
      { data: "abc", mimeType: "image/jpeg" },
      { url: "https://example.com/a.png" },
    ]);
  });

  it("returns empty for missing images", () => {
    expect(toCursorSdkImages(undefined)).toEqual([]);
    expect(toCursorSdkImages([])).toEqual([]);
  });
});
