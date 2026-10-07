import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectSheet } from "./ProjectSheet";

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(impersonating: boolean) {
  await act(async () => {
    root!.render(
      <ProjectSheet open kind="project" sheetKey="p:1" backdropHref="/" onRequestClose={() => {}} impersonating={impersonating}>
        <div>body</div>
      </ProjectSheet>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null; host.remove(); document.body.replaceChildren();
});

describe("ProjectSheet scrim under impersonation (#531)", () => {
  it("starts the scrim below the banner and shields the strip while impersonating", async () => {
    await render(true);
    const scrim = document.querySelector('[data-testid="project-sheet-scrim"]')!;
    expect(scrim.hasAttribute("data-impersonating")).toBe(true);
    expect(scrim.className).toContain("data-[impersonating]:top-[var(--impersonation-banner-height)]");
    expect(scrim.className).toContain("data-[impersonating]:before:h-[var(--impersonation-banner-height)]");
  });

  it("leaves the scrim untouched when not impersonating", async () => {
    await render(false);
    expect(document.querySelector('[data-testid="project-sheet-scrim"]')!.hasAttribute("data-impersonating")).toBe(false);
  });
});

describe("ProjectSheet close button backing (#670)", () => {
  it("carries the .worktools frosted backing so a scrolled section rule never runs through the ×", async () => {
    await render(false);
    const close = document.querySelector<HTMLElement>('[data-testid="project-sheet-close"]')!;
    expect(close.className).toContain("bg-[color-mix(in_srgb,var(--paper-050)_90%,transparent)]");
    expect(close.className).toContain("backdrop-blur-[8px]");
  });
});

describe("ProjectSheet focus (#607)", () => {
  it("opening focuses the named Project workspace dialog", async () => {
    await render(false);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby]');
    expect(dialog).not.toBeNull();
    expect(document.getElementById(dialog!.getAttribute("aria-labelledby")!)?.textContent).toBe("Project workspace");
    for (let i = 0; i < 20 && document.activeElement !== dialog; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(document.activeElement).toBe(dialog);
  });
});
