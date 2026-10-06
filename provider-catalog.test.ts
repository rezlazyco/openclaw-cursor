import { describe, expect, it } from "vitest";
import {
  FALLBACK_CURSOR_MODELS,
  mergeCursorCatalogModels,
  normalizeCursorCatalogModelId,
} from "./provider-catalog.js";

describe("normalizeCursorCatalogModelId", () => {
  it("maps Cursor default model id to auto", () => {
    expect(normalizeCursorCatalogModelId("default")).toBe("auto");
    expect(normalizeCursorCatalogModelId(" composer-2.5 ")).toBe("composer-2.5");
  });
});

describe("mergeCursorCatalogModels", () => {
  it("keeps fallback models when discovery is empty", () => {
    const merged = mergeCursorCatalogModels([]);
    expect(merged.map((model) => model.id)).toEqual(
      FALLBACK_CURSOR_MODELS.map((model) => model.id),
    );
  });

  it("merges discovered models and preserves fallback auto metadata", () => {
    const merged = mergeCursorCatalogModels([
      {
        id: "default",
        model: "default",
        displayName: "default",
        inputModalities: ["text"],
      },
      {
        id: "composer-2.5",
        model: "composer-2.5",
        displayName: "Composer 2.5",
        inputModalities: ["text", "image"],
      },
      {
        id: "grok-4.5",
        model: "grok-4.5",
        displayName: "Grok 4.5",
        inputModalities: ["text", "image"],
      },
    ]);

    expect(merged.map((model) => model.id)).toEqual(["auto", "composer-2.5", "grok-4.5"]);
    expect(merged[0]?.description).toContain("Let Cursor pick");
  });
});
