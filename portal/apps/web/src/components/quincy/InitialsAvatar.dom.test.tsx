import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { InitialsAvatar } from "./InitialsAvatar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
});

function mount(className?: string) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<InitialsAvatar name="Ada Lovelace" className={className} />));
  return host.firstElementChild as HTMLElement;
}

// #324: a highlighted option row paints `--accent` (ink), InitialsAvatar's own fill, so the circle
// vanished on the row about to be picked. The avatar carries a paper ring in that context itself,
// for every Base UI list (`data-highlighted`), instead of each consumer patching it.
describe("InitialsAvatar on a highlighted row (#324)", () => {
  it("carries a paper ring scoped to a highlighted ancestor", () => {
    const classes = mount().className.split(/\s+/);
    expect(classes).toContain("[[data-highlighted]_&]:ring-1");
    expect(classes).toContain("[[data-highlighted]_&]:ring-[var(--paper-050)]");
  });

  it("keeps the ring when a consumer passes its own className", () => {
    const classes = mount("size-5").className.split(/\s+/);
    expect(classes).toContain("size-5");
    expect(classes).toContain("[[data-highlighted]_&]:ring-[var(--paper-050)]");
  });
});
