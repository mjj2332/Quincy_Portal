import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

  const trigger = () => document.querySelector<HTMLElement>('[data-testid="embedded-image"]')!;

  it("hands the stylesheet the recorded size on the trigger, so the button can hug the capped image", () => {
    thumbnail({ width: 400, height: 1200 });
    expect(Number(trigger().style.getPropertyValue("--embedded-image-aspect"))).toBeCloseTo(400 / 1200, 5);
    expect(trigger().style.getPropertyValue("--embedded-image-width")).toBe("400");
    expect(trigger().hasAttribute("data-sized")).toBe(true);
  });

  it("sets none of that on the trigger of an unsized image", () => {
    thumbnail({});
    expect(trigger().style.getPropertyValue("--embedded-image-aspect")).toBe("");
    expect(trigger().hasAttribute("data-sized")).toBe(false);
  });

  it("sizes a sized trigger to the image's width, capped at the container and at the height limit times the aspect ratio, with the image filling it", () => {
    const appCss = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../styles/app.css"), "utf8");
    const line = (selector: string) => appCss.split("\n").find((value) => value.startsWith(selector)) ?? "";
    const button = line(".rich-text__embedded-image-trigger[data-sized] {");
    expect(button).toContain("width: calc(var(--embedded-image-width) * 1px)");
    expect(button).toContain("max-width: min(100%, calc(24rem * var(--embedded-image-aspect)))");
    const image = line(".rich-text__embedded-image-trigger[data-sized] > .rich-text__embedded-image");
    expect(image).toContain("width: 100%");
    // The box already has the image's ratio, so `contain` would only add a strip where the 1px border skews it.
    expect(image).toContain("object-fit: fill");
    expect(line(".rich-text__embedded-image {")).toContain("max-height: 24rem");
    expect(line(".rich-text__embedded-image[data-sized]")).toBe("");
  });
});
