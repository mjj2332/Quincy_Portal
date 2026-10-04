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
