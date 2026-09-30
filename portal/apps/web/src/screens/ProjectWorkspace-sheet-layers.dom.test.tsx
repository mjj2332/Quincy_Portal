import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { ProjectSheet } from "../components/quincy/ProjectSheet";
import { ConfirmModalHost } from "../components/ConfirmDialog";
import { confirm, confirmStore } from "../lib/confirm";
import { QuincyQueryProvider } from "../lib/query-client";
import type { WorkspaceAsset } from "../components/PhotoGrid";
import type { Role } from "@quincy/shared";

/**
 * #375 — popover-first dismissal inside the Project sheet, with the REAL Workspace: while a popover,
 * menu, select, combobox or mention list is open inside the sheet, the first outside press / Escape
 * closes only that layer; the second closes the sheet. Harness lifted from
 * `ProjectWorkspace-sheet.dom.test.tsx`.
 */
const authState = vi.hoisted(() => ({ role: "admin" }));
vi.mock("../lib/auth", () => ({
  useSession: () => ({ data: { user: { id: "user-1", role: authState.role } }, isPending: false }),
}));

const apiGetMock = vi.fn<(path: string, init?: unknown) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string, init?: unknown) => apiGetMock(path, init), apiPost: vi.fn(() => Promise.resolve({})), apiPatch: vi.fn(() => Promise.resolve({})), apiDelete: vi.fn(() => Promise.resolve({})) };
});

if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

function workspaceAsset(id: string): WorkspaceAsset {
  return { id, section: null, collectionId: "collection", kind: "photo", originalFilename: `${id}.jpg`, bytes: 1, width: null, height: null, ratingFromMetadata: null, renditionStatus: "ready", createdAt: "2026-07-21T00:00:00.000Z", sourceRawAssetId: null, version: 1, versionGroupId: null, supersedesAssetId: null, review: null, selected: false };
}

function projectFixture() {
  return {
    id: "p1", street: "12 Example St", suburb: "Suburbia", postcode: "2000",
    agencyName: null, agentName: null, shootDate: null, stageKey: "raw_review", boardRevision: 7, contractEnabled: true,
    rawFolderPath: null, rawFolderLink: null, coverAssetId: null, effectiveCoverAssetId: null,
    collections: [
      { id: "c-raw", kind: "raw", status: "active", expectedCount: null, receivedCount: 2 },
      { id: "c-edited", kind: "edited", status: "active", expectedCount: null, receivedCount: 1 },
    ],
    members: [],
    deadlineSchedule: { version: 0, deadline: null, reminderOffsetsMinutes: [], state: "unset", nextOccurrence: null, canResume: false },
  };
}

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush(times = 10) {
  for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}
async function flushUntil(predicate: () => boolean, label: string, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    if (predicate()) break;
    if (Date.now() > deadline) throw new Error(`flushUntil timed out after ${timeoutMs}ms waiting for: ${label}`);
  }
  await flush(5);
}
const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await Promise.resolve(); });
const escape = (target: EventTarget) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
const tab = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')].find((item) => item.textContent?.trim().startsWith(name));
const lightbox = () => document.querySelector('[role="dialog"][aria-label="Photo viewer"]');

/**
 * A keyboard Tab as a browser performs it: dispatch the keydown, and unless something prevented it,
 * move focus to the next/previous tabbable in document order (focus guards included, which is how
 * Floating UI's modal manager wraps focus). happy-dom does not move focus on Tab by itself.
 */
const pressTab = (shift = false) => act(async () => {
  const from = (document.activeElement ?? document.body) as HTMLElement;
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true, cancelable: true });
  from.dispatchEvent(event);
  if (!event.defaultPrevented) {
    const order = [...document.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]')].filter((el) => el.getAttribute("tabindex") !== "-1");
    const at = order.indexOf(from);
    const next = order[(at + (shift ? -1 : 1) + order.length) % order.length];
    next?.focus();
  }
  await Promise.resolve();
});
const confirmFocusables = (modal: HTMLElement) => [...modal.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]')].filter((el) => el.getAttribute("tabindex") !== "-1" && !el.hasAttribute("data-floating-ui-focus-guard"));

const onRequestClose = vi.fn();

async function renderSheet(props: { arrivalTab?: "raw" | "collaboration"; arrivalSignal?: number } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const ui: ReactNode = (
    <QuincyQueryProvider key="test" principalId="test-user" role={authState.role as Role}>
      <ProjectSheet open kind="project" sheetKey="project:p1" backdropHref="/" onRequestClose={onRequestClose}>
        <ProjectWorkspace projectId="p1" arrivalSignal={props.arrivalSignal} arrivalTab={props.arrivalTab} onArrivalConsumed={() => undefined} />
      </ProjectSheet>
      <ConfirmModalHost />
    </QuincyQueryProvider>
  );
  await act(async () => { root!.render(ui); await Promise.resolve(); });
  await flushUntil(() => tab("Collaboration") !== undefined, "the Workspace tabs inside the sheet");
  return host;
}

beforeEach(() => {
  authState.role = "admin";
  onRequestClose.mockReset();
  apiGetMock.mockReset();
  apiGetMock.mockImplementation((path: string) => {
    if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
    if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1"), workspaceAsset("raw-2")] });
    if (path.includes("/assets?collection=edited")) return Promise.resolve({ assets: [workspaceAsset("edited-1")] });
    if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
    if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: "p1", marker: null, latest: null, unreadCount: 0 });
    if (path.includes("comments")) return Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [] });
    if (path.includes("annotations")) return Promise.resolve({ annotations: [] });
    if (path.includes("subtasks")) return Promise.resolve({ subtasks: [] });
    if (path.includes("mentionable-users")) return Promise.resolve({ users: [] });
    return Promise.resolve({});
  });
});

afterEach(async () => {
  while (confirmStore.getSnapshot()) confirmStore.resolve(false);
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  document.body.replaceChildren();
});


const scrim = () => document.querySelector<HTMLElement>('[data-testid="project-sheet-scrim"]')!;
async function outsidePress() {
  await act(async () => {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) scrim().dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }) : new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
    await Promise.resolve();
  });
  await flush();
}
async function press(key: string, target: EventTarget = document.activeElement ?? document.body) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); await Promise.resolve(); });
  await flush();
}

/** Each entry opens one popup inside the sheet and says how to see it and where focus returns. */
const LAYERS: { name: string; trigger: () => HTMLElement | null | undefined; open: (trigger: HTMLElement) => Promise<void>; isOpen: () => boolean; escapeTarget?: () => Element | null }[] = [
  {
    name: "the stage Select",
    trigger: () => document.querySelector<HTMLElement>('[aria-label="Move project Stage"]'),
    open: async (trigger) => { trigger.focus(); await click(trigger); await flush(); },
    isOpen: () => document.querySelector('[data-testid="project-sheet-overlay-slot"] [data-open] [role="listbox"]') !== null,
  },
  {
    name: "the deadline popover",
    trigger: () => [...document.querySelectorAll<HTMLElement>('[data-testid="project-header"] button')].find((button) => /deadline/i.test(button.textContent ?? "") || /deadline/i.test(button.getAttribute("aria-label") ?? "")),
    open: async (trigger) => { trigger.focus(); await click(trigger); await flush(); },
    isOpen: () => document.querySelector('[data-testid="project-sheet-overlay-slot"] [role="dialog"][data-open]') !== null,
  },
];

describe("popover-first dismissal in the real Workspace (#375)", () => {
  it.each(LAYERS.map((layer) => [layer.name, layer] as const))("%s: the first outside press closes only the popup; the second closes the sheet", async (_name, layer) => {
    await renderSheet();
    const trigger = layer.trigger();
    expect(trigger, "trigger present in the Workspace").toBeTruthy();
    await layer.open(trigger!);
    expect(layer.isOpen()).toBe(true);

    await outsidePress();
    expect(layer.isOpen()).toBe(false);
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="project-sheet"]')).not.toBeNull();

    await outsidePress();
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it.each(LAYERS.map((layer) => [layer.name, layer] as const))("%s: Escape closes the popup first, returns focus to its trigger, then the sheet", async (_name, layer) => {
    await renderSheet();
    const trigger = layer.trigger()!;
    await layer.open(trigger);
    expect(layer.isOpen()).toBe(true);

    await press("Escape");
    expect(layer.isOpen()).toBe(false);
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);

    await press("Escape");
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it("an open tooltip never blocks the sheet's Escape", async () => {
    await renderSheet();
    const close = document.querySelector<HTMLElement>('[data-testid="project-sheet-close"]')!;
    const tip = document.createElement("div");
    tip.setAttribute("data-open", "");
    tip.setAttribute("role", "tooltip");
    document.querySelector('[data-testid="project-sheet-overlay-slot"]')!.append(tip);
    await press("Escape", close);
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });
});

describe("the mention list inside the sheet (#375)", () => {
  async function typeMention(mention: string) {
    await renderSheet();
    await click(tab("Collaboration")!);
    await flushUntil(() => document.querySelector('[contenteditable="true"]') !== null, "the discussion composer");
    const editor = document.querySelector<HTMLElement>('[data-testid="discussion-composer"] [contenteditable="true"]')!;
    editor.focus();
    await act(async () => {
      editor.querySelector("p")!.append(document.createTextNode(mention));
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: mention }));
      await Promise.resolve(); await Promise.resolve();
    });
    await flush();
    return editor;
  }
  const withMentionables = (impl: () => Promise<unknown>) => {
    const base = apiGetMock.getMockImplementation()!;
    apiGetMock.mockImplementation((path: string, init?: unknown) => path.includes("mentionable-users") ? impl() : base(path, init));
  };

  it.each([
    ["results", () => Promise.resolve({ users: [{ id: "11111111-1111-4111-8111-111111111111", name: "Nora Mention", role: "editor" }] })],
    ["no results", () => Promise.resolve({ users: [] })],
    ["loading", () => new Promise(() => undefined)],
  ] as const)("Escape with the list in its %s state closes the list, not the sheet; the next Escape closes the sheet", async (_state, impl) => {
    withMentionables(impl);
    const editor = await typeMention("@fo");
    expect(editor.getAttribute("aria-expanded")).toBe("true");
    await press("Escape", editor);
    expect(editor.getAttribute("aria-expanded")).toBe("false");
    expect(onRequestClose).not.toHaveBeenCalled();
    await press("Escape", editor);
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it("an outside press with the list open dismisses the list; the second closes the sheet; typing reopens it", async () => {
    withMentionables(() => Promise.resolve({ users: [] }));
    const editor = await typeMention("@fo");
    await outsidePress();
    expect(editor.getAttribute("aria-expanded")).toBe("false");
    expect(onRequestClose).not.toHaveBeenCalled();
    await outsidePress();
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });
});
