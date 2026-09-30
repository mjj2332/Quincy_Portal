import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DateGroupHeading } from "./DateGroupHeading";

let root: Root;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("DateGroupHeading", () => {
  it("renders an h3 with the id, the label as an eyebrow and a decorative rule", () => {
    act(() => { root.render(<DateGroupHeading id="day-1" label="Yesterday" />); });
    const heading = host.querySelector("h3")!;
    expect(heading.id).toBe("day-1");
    expect(heading.textContent).toBe("Yesterday");
    const [label, rule] = heading.querySelectorAll("span");
    expect(label!.textContent).toBe("Yesterday");
    expect(rule!.getAttribute("aria-hidden")).toBe("true");
    expect(rule!.textContent).toBe("");
  });

  it("merges the consumer's className so vertical spacing stays with the consumer", () => {
    act(() => { root.render(<DateGroupHeading id="d" label="Today" className="pt-[var(--space-5)] pb-[var(--space-1)]" />); });
    const heading = host.querySelector("h3")!;
    expect(heading.className).toContain("pt-[var(--space-5)]");
    expect(heading.className).toContain("flex");
  });
});
