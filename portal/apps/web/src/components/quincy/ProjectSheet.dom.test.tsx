import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockViewport, type MockViewport } from "../../testing/viewport";
import { EDGE_TINT_HOLD_MS } from "./SafariEdgeTint";
import { PROJECT_SHEET_PHONE_QUERY, ProjectSheet, useClaimSheetClose, useProjectSheet } from "./ProjectSheet";

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

describe("ProjectSheet body focus clearance (#673)", () => {
  it("gives the scroller scroll padding so a focused mid-form control's ring is not clipped", async () => {
    await render(false);
    expect(document.querySelector('[data-testid="project-sheet-body"]')!.className).toContain("scroll-py-[var(--space-2)]");
  });
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
    // Phone widths only: on desktop the × sits on the sheet header beside bare icons, and a tile reads as a stray square.
    // `not-hover:not-aria-expanded:` so the ghost button's own hover and expanded fills still win.
    expect(close.className).toContain("max-[721px]:not-hover:not-aria-expanded:bg-[color-mix(in_srgb,var(--paper-050)_90%,transparent)]");
    expect(close.className).toContain("max-[721px]:backdrop-blur-[8px]");
    expect(close.className.split(/\s+/)).not.toContain("bg-[color-mix(in_srgb,var(--paper-050)_90%,transparent)]");
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

// #914: the phone header renders its own Close, so it claims the sheet's while it is mounted.
function Claimer() { useClaimSheetClose(); return <span data-testid="claimer" />; }
function ContextReader({ onRead }: { onRead: (value: ReturnType<typeof useProjectSheet>) => void }) { onRead(useProjectSheet()); return null; }

describe("ProjectSheet Close claim (#914)", () => {
  async function renderWith(children: React.ReactNode) {
    await act(async () => {
      root!.render(<ProjectSheet open kind="project" sheetKey="p:1" backdropHref="/" onRequestClose={() => {}}>{children}</ProjectSheet>);
      await Promise.resolve(); await Promise.resolve();
    });
  }
  const close = () => document.querySelector('[data-testid="project-sheet-close"]');

  it("drops its own Close while a child claims it, and restores it when every claim is released", async () => {
    await renderWith(<><Claimer /><Claimer /></>);
    expect(close()).toBeNull();
    await renderWith(<Claimer />);
    expect(close()).toBeNull();
    await renderWith(<div>body</div>);
    expect(close()).not.toBeNull();
  });

  it("exposes close() and its scroll body to the content", async () => {
    let read: ReturnType<typeof useProjectSheet> = null;
    await renderWith(<ContextReader onRead={(value) => { read = value; }} />);
    await act(async () => { await Promise.resolve(); });
    expect(read).not.toBeNull();
    expect(typeof read!.close).toBe("function");
    expect(read!.body).toBe(document.querySelector('[data-testid="project-sheet-body"]'));
  });

  it("names the phone query its own max-[721px]: variant compiles to", () => {
    expect(PROJECT_SHEET_PHONE_QUERY).toBe("(width < 721px)");
  });
});

// #927 follow-up: Safari keeps the tint it took when a film was open. Closing the film re-tints it light with fresh strips.
describe("ProjectSheet Safari edge tint when a film closes", () => {
  const strips = () => [...document.querySelectorAll<HTMLElement>('[data-testid="project-sheet"] [data-testid="safari-edge-tint"]')];
  async function renderFilm(filmOpen: boolean) {
    await act(async () => {
      root!.render(
        <ProjectSheet open kind="project" sheetKey="p:1" backdropHref="/" onRequestClose={() => {}} filmOpen={filmOpen}>
          <div>body</div>
        </ProjectSheet>,
      );
      await Promise.resolve();
    });
  }
  let viewport: MockViewport;
  afterEach(() => { viewport.restore(); vi.useRealTimers(); });

  it("on a phone, mounts light strips when a film closes and drops them after the hold", async () => {
    viewport = mockViewport({ width: 390 });
    await renderFilm(true);
    expect(strips()).toHaveLength(0);
    vi.useFakeTimers();
    await renderFilm(false);
    expect(strips()).toHaveLength(2);
    for (const strip of strips()) expect(strip.className.split(/\s+/)).toContain("bg-background");
    await act(async () => { vi.advanceTimersByTime(EDGE_TINT_HOLD_MS); });
    expect(strips()).toHaveLength(0);
  });

  it("a Project opened with no film never mounts them, and a film opening does not either (the viewer owns the dark tint)", async () => {
    viewport = mockViewport({ width: 390 });
    await renderFilm(false);
    expect(strips()).toHaveLength(0);
    await renderFilm(true);
    expect(strips()).toHaveLength(0);
  });

  it("desktop never mounts them", async () => {
    viewport = mockViewport({ width: 1280 });
    await renderFilm(true);
    await renderFilm(false);
    expect(strips()).toHaveLength(0);
  });
});
