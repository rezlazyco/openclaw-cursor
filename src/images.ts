/**
 * Maps OpenClaw prompt images into Cursor SDK image payloads.
 */
import type { SDKImage } from "@cursor/sdk";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Converts OpenClaw ImageContent-like objects into Cursor SDKImage entries. */
export function toCursorSdkImages(images: unknown[] | undefined): SDKImage[] {
  if (!Array.isArray(images) || images.length === 0) {
    return [];
  }
  const out: SDKImage[] = [];
  for (const image of images) {
    if (!isRecord(image)) {
      continue;
    }
    if (image.type === "image" && typeof image.data === "string" && image.data.trim()) {
      const mimeType =
        typeof image.mimeType === "string" && image.mimeType.trim()
          ? image.mimeType.trim()
          : "image/png";
      out.push({ data: image.data, mimeType });
      continue;
    }
    if (typeof image.url === "string" && image.url.trim()) {
      out.push({ url: image.url.trim() });
    }
  }
  return out;
}
