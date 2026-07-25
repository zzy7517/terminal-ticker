import type { ImageContent } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { validateClaudeImages } from "./claude-session-stream.js";
import { validateCursorImages } from "./cursor-session-stream.js";
import { validateImageInput } from "./image-input.js";

describe("Runtime image input", () => {
  it("rejects non-canonical base64 through every Runtime validator", () => {
    for (const validate of [validateImageInput, validateClaudeImages, validateCursorImages]) {
      expect(validate([image("A")])).toBe("image data must be valid base64");
    }
  });

  it("rejects more than ten images", () => {
    expect(validateImageInput(Array.from({ length: 11 }, () => image("YQ=="))))
      .toBe("at most 10 images are allowed");
  });

  it("rejects images above the cumulative request budget", () => {
    const payload = Buffer.alloc(13 * 1024 * 1024).toString("base64");
    expect(validateImageInput([image(payload), image(payload)]))
      .toBe("images must be at most 25 MB in total");
  });
});

function image(data: string): ImageContent {
  return { type: "image", data, mimeType: "image/png" };
}
