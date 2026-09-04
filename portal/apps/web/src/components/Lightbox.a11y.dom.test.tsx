/**
 * TB8-09 accessibility guards for the review Lightbox.
 *
 * Each test locks in one defect this release fixed, at the level the defect actually lived. They
 * are collected here rather than scattered through `Lightbox.dom.test.tsx` because every one of
 * them guards something *invisible* until measured — nine buttons with no accessible name, five
 * that all computed the same name, a focus ring at 1.00:1, a transparent outline that beat
 * `:focus-visible` on source order. A future sweep reading the component alone will not see why
 * the current shape matters. See `docs/plans/TB8-09-Lightbox-Controls-Visual-Plan.md` §6.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Lightbox } from "./Lightbox";
import type { WorkspaceAsset } from "./PhotoGrid";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(join(here, relative), "utf8");

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: vi.fn(async () => ({ annotations: [] })), apiPost: vi.fn(async () => ({})), apiPatch: vi.fn(async () => ({})) };
});
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1" } } }) }));

/**
 * Not a full accessible-name computation — the four sources these controls actually use, in spec
 * order. This repo has no `dom-accessibility-api` and no `@testing-library/dom`, and this release
 * deliberately does not add one: `ProjectOverviewRail.dom.test.tsx:163` already establishes the
 * manual approach. Adding a dependency to assert a name is a bigger change than the fix it guards.
 */
function accessibleName(el: HTMLElement): string {
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    return labelledby.split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim() ?? "")
      .join(" ").trim();
  }
  const label = el.getAttribute("aria-label");
  if (label?.trim()) return label.trim();
  const text = [...el.childNodes]
    .filter((node) => !(node instanceof HTMLElement) || node.getAttribute("aria-hidden") !== "true")
    .map((node) => node.textContent ?? "").join("").trim();
  if (text) return text;
  return el.getAttribute("title")?.trim() ?? "";
}

function asset(id: string, overrides: Partial<WorkspaceAsset> = {}): WorkspaceAsset {
  return {
    id, section: null, collectionId: "collection", kind: "photo", originalFilename: `${id}.jpg`,
    bytes: 1, width: null, height: null, ratingFromMetadata: null, renditionStatus: "ready",
    createdAt: "2026-07-21T00:00:00.000Z", sourceRawAssetId: null, version: 1, versionGroupId: null,
    supersedesAssetId: null, review: null, selected: false, ...overrides,
  };
}

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// `viewerBand()` reads window.innerWidth, and the side panel only renders inline at desktop
// width — below 1081px it is a drawer that starts closed. happy-dom's default is narrower than
// that, so without this the panel's own controls never mount and a test asserting on them
// silently passes over an empty list rather than failing loudly. Set the band explicitly.
beforeEach(() => { window.innerWidth = 1440; });

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  return host;
}
async function render(value: ReactNode) {
  await act(async () => { root!.render(value); await Promise.resolve(); await Promise.resolve(); });
}
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null; }
  document.body.innerHTML = "";
});

function lightbox(props: Partial<Parameters<typeof Lightbox>[0]> = {}) {
  const assets = [asset("a"), asset("b")];
  return <Lightbox
    assets={assets} rawAssets={[]} initialAssetId="a" collectionKind="edited"
    canReview canRecommend canAnnotate
    onClose={() => undefined} onReview={async () => undefined} onToast={() => undefined}
    {...props}
  />;
}

describe("TB8-09 §2 — every markup-toolbar button has an accessible name", () => {
  // The defect: six `.swatch` buttons were `<button style={{background}} />` — self-closing, no
  // children, no aria-label, no title. Three `.wbtn` buttons wrapped an empty presentational
  // span. Nine anonymous buttons in one toolbar: a screen-reader user heard nine unlabelled
  // controls and a voice-control user could not address any of them at all.
  //
  // Asserted over EVERY button in the toolbar rather than a fixed count: the toolbar holds 11
  // ordinarily and 13 in drawing-edit mode; nine is only the formerly-unnamed subset.
  let host: HTMLElement;
  beforeEach(async () => { host = mount(); await render(lightbox()); });

  it("names every button in the toolbar", () => {
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".drawbar button")];
    expect(buttons.length).toBeGreaterThanOrEqual(11);
    const unnamed = buttons.filter((button) => accessibleName(button) === "");
    expect(unnamed).toHaveLength(0);
  });

  it("gives the six pen colours six distinct names", () => {
    const swatches = [...host.querySelectorAll<HTMLButtonElement>(".drawbar .swatch")];
    expect(swatches).toHaveLength(6);
    expect(new Set(swatches.map(accessibleName)).size).toBe(6);
  });

  it("gives the three stroke widths three distinct names", () => {
    const widths = [...host.querySelectorAll<HTMLButtonElement>(".drawbar .wbtn")];
    expect(widths).toHaveLength(3);
    expect(new Set(widths.map(accessibleName)).size).toBe(3);
  });

  it("keeps the painted dot out of the accessible name", () => {
    // The button carries no colour; an aria-hidden inner span carries the paint. That is what
    // lets the target grow to 28/44 while the visible dot stays 19px.
    for (const swatch of host.querySelectorAll<HTMLButtonElement>(".drawbar .swatch")) {
      expect(swatch.querySelector("span")?.getAttribute("aria-hidden")).toBe("true");
    }
  });
});

describe("TB8-09 §5.4 — the rating buttons are individually addressable", () => {
  // The defect: five `<button>★</button>`. All five computed the same accessible name, "★" —
  // nothing distinguished one star from five to a screen reader or to voice control.
  it("gives the five rating buttons five distinct names", async () => {
    const host = mount();
    await render(lightbox());
    const stars = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Rating"] button')];
    expect(stars).toHaveLength(5);
    expect(new Set(stars.map(accessibleName)).size).toBe(5);
  });
});

describe("TB8-09 §0c — state is announced, and these are toggles not radios", () => {
  // Selected state used to be carried by colour, a ring or a background alone (WCAG 1.4.1/4.1.2).
  // aria-pressed and not role="radio": every one of these clears its value on re-click, which
  // radio semantics cannot express — and role="radio" would oblige a roving tabIndex plus
  // Arrow/Home/End handling that nothing here implements.
  const source = read("./Lightbox.tsx");

  it("uses no radio roles anywhere", () => {
    expect(source).not.toMatch(/role="radio/);
  });

  it("marks exactly one pen colour and one stroke width as pressed", async () => {
    const host = mount();
    await render(lightbox());
    for (const group of [".swatch", ".wbtn"]) {
      const pressed = [...host.querySelectorAll(`.drawbar ${group}`)]
        .filter((button) => button.getAttribute("aria-pressed") === "true");
      expect(pressed).toHaveLength(1);
    }
  });

  it("presses no rating button when the asset has no rating", async () => {
    const host = mount();
    await render(lightbox());
    const pressed = [...host.querySelectorAll('[aria-label="Rating"] button')]
      .filter((button) => button.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(0);
  });

  it("keeps the rating's cumulative paint distinct from its pressed state", () => {
    // Deliberately different conditions: `n <= stars` paints every star up to the rating, which
    // is what makes it read as a rating rather than five independent switches, while
    // `n === stars` presses only the one button that sets the value. Do not unify them.
    expect(source).toContain("number <= stars");
    expect(source).toContain("number === stars");
  });

  it("gives the desktop decision buttons the aria-pressed the peek bar always had", () => {
    // The register's finding: both of this file's aria-pressed attributes lived on the phone
    // peek bar. The desktop path never got them. The phone band was the correct implementation.
    expect(source).toMatch(/aria-pressed=\{asset\.review\?\.decision === "approved"\}/);
    expect(source).toMatch(/aria-pressed=\{asset\.review\?\.decision === "flagged"\}/);
  });
});

describe("TB8-09 §8 — the focus ring is not defeated by a transparent outline", () => {
  // The filmstrip had a SECOND, independent cause of its invisible focus ring, on top of the
  // --focus-ring/--ink-900 collision: `.strip__button { outline: 2px solid transparent }`.
  // Both it and `:focus-visible` have specificity (0,1,0), and index.css imports app.css AFTER
  // tokens/base.css — so the later rule won and the thumbnails stayed ringless regardless of the
  // token. The fix is deletion, never out-specifying it. TB8's third sighting of this trap.
  //
  // Asserted against the stylesheet source, not a computed style: Lightbox.dom.test.tsx does not
  // import index.css, so a computed-style assertion would read nothing. The defect was a rule
  // that should not exist, so testing for its absence is both implementable and closer to true.
  const css = read("../styles/app.css");

  it("declares no outline for .strip__button in app.css", () => {
    expect(css).not.toMatch(/\.strip__button[^{]*\{[^}]*outline/);
  });
});

describe("TB8-09 §2.3 — the two surface scopes stay in sync", () => {
  // A data attribute resets nothing on its own. `.vpanel` is a descendant of the inverse-scoped
  // `.viewer`, so any role the inverse block sets and the default block omits would inherit an
  // ink value into the light panel — invisible in review, obvious only in a browser.
  const inverse = read("../styles/tokens/inverse.css");
  const propertiesOf = (selector: string) => {
    const block = new RegExp(`\\[data-surface="${selector}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`).exec(inverse);
    const body = block?.[1];
    expect(body, `missing [data-surface="${selector}"] block`).toBeDefined();
    return [...body!.matchAll(/(--[a-z-]+)\s*:/g)].map((match) => match[1]);
  };

  it("declares the same property set in both blocks", () => {
    const dark = propertiesOf("inverse");
    const light = propertiesOf("default");
    expect(dark.length).toBeGreaterThan(0);
    expect([...light].sort()).toEqual([...dark].sort());
  });

  it("sets both --ring and --focus-ring", () => {
    // Two independent paths paint a focus ring here: Tailwind utilities read --ring, while the
    // unlayered global `:focus-visible` in tokens/base.css names --focus-ring directly and, being
    // unlayered, beats a layered outline-* utility. Scoping only --ring leaves the second path
    // painting ink-on-ink at 1.00:1 — the headline defect, half-fixed and looking fixed.
    for (const property of ["--ring:", "--focus-ring:"]) {
      expect(propertiesOf("inverse").join(" ")).toContain(property.slice(0, -1));
      expect(propertiesOf("default").join(" ")).toContain(property.slice(0, -1));
    }
  });
});

describe("TB8-09 §4 — the class names the retired rules still depend on survive", () => {
  // "Retired" means the CSS rule is deleted and the class name stays as a hook. These four MUST
  // remain: two are still selected by kept rules, one is a live runtime selector, one is queried
  // by the phone sheet's kept geometry. The counterpart to the ledger's zero-rules criterion, so
  // that "retired" cannot be over-applied into deleting a name something still needs.
  const source = read("./Lightbox.tsx");

  it.each([
    ["viewer", "`.app--impersonating .viewer` still selects it"],
    ["viewer__img", "`.canvasframe .viewer__img` still selects it"],
    ["vpanel", "the kept ≤720px bottom-sheet block still selects it"],
    ["viewer__panel-trigger", "it is a live runtime selector in this file's own key handler"],
  ])("keeps the %s class name (%s)", (className) => {
    expect(source).toContain(className);
  });
});

describe("TB8-09 §5 — phantom tokens do not come back", () => {
  // --signal-warm and --panel were both used and defined nowhere, surviving only because each
  // carried a literal fallback that happened to be right. Same family as TB8-07's
  // --signal-warning, which had no fallback and rendered as inherited ink for its whole life.
  it.each(["--signal-warm", "--panel"])("has no %s anywhere in the stylesheets", (token) => {
    for (const file of ["../styles/app.css", "../styles/tokens/colors.css", "../styles/tokens/inverse.css"]) {
      expect(read(file)).not.toContain(token);
    }
  });
});
