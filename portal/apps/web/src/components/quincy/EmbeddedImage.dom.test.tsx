import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { RichTextDoc } from "@quincy/shared";
import { RichTextContent } from "../RichTextContent";

/** A posted embedded image reserves its box before it loads (#611): the thumbnail carries the recorded size when the server gave one. */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const A = "11111111-1111-4111-8111-111111111111";
let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });

function thumbnail(attrs: Record<string, unknown>): HTMLImageElement {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const content = { type: "doc", content: [{ type: "image", attrs: { mediaId: A, ...attrs } }] } as RichTextDoc;
  act(() => root!.render(<RichTextContent content={content} />));
  return host.querySelector<HTMLImageElement>('[data-testid="embedded-image"] img')!;
}

describe("an embedded image's reserved box (#611)", () => {
  it("sets the width and height attributes when the post carries them, so the box exists before the file loads", () => {
    const image = thumbnail({ width: 511, height: 384 });
    expect(image.getAttribute("width")).toBe("511");
    expect(image.getAttribute("height")).toBe("384");
  });

  it("keeps lazy loading and the same source", () => {
    const image = thumbnail({ width: 511, height: 384 });
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(image.getAttribute("src")).toBe(`/media/embedded/${A}`);
  });

  it("sets neither attribute for an image with no recorded size, as before", () => {
    const image = thumbnail({});
    expect(image.hasAttribute("width")).toBe(false);
    expect(image.hasAttribute("height")).toBe(false);
  });

  it("sets neither attribute for half a size", () => {
    const image = thumbnail({ width: 511 });
    expect(image.hasAttribute("width")).toBe(false);
    expect(image.hasAttribute("height")).toBe(false);
  });
});
