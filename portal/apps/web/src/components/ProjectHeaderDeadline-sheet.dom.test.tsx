import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectDeadlineSchedule } from "@quincy/shared";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";
import { ProjectSheet } from "./quincy/ProjectSheet";
import { ProjectHeaderDeadline } from "./ProjectHeaderDeadline";
import { pickPopupDateTime, applyPopup } from "@/testing/date-time-popup";
import { emulateSheetRestoreFocus } from "@/testing/sheet-restore-focus";

/**
 * #664 (#662 item 2) — the header Deadline's popover renders inside the modal Project sheet, whose
 * `restoreFocus: "popup"` reclaims focus a frame after the popover closes (lesson "Adopting
 * base-nova's sidebar…", P3; the same fix as `quincy/menu.tsx`). happy-dom does not reproduce the
 * sheet's own refocus, so this pins the mechanism: focus is on the trigger the moment the popover
 * closes and still there a frame later. The sheet's refocus is EMULATED below (`testing/sheet-restore-focus.ts`), so a pass here is
 * not proof against the real sheet: the browser pass is (docs/lessons.md, "A focus test can pass because something else restored focus").
 */

const apiPutMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiPut: (path: string, body: unknown) => apiPutMock(path, body) };
});
vi.mock("../lib/shell-chrome", () => ({ shellChromeBottom: () => 0 }));

const projectId = "11111111-1111-4111-8111-111111111111";
const emptySchedule: ProjectDeadlineSchedule = { version: 0, source: null, deadline: null, reminderOffsetsMinutes: [], state: "unset", nextOccurrence: null, canResume: false };

let root: Root | null = null;
let host: HTMLElement;
let queryClient: QueryClient;
let runtime: ProjectQueryRuntime;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mountInSheet() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  runtime = new ProjectQueryRuntime(queryClient);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ProjectQueryRuntimeProvider runtime={runtime}>
        <QueryClientProvider client={queryClient}>
          <ProjectSheet open kind="project" sheetKey="p:1" backdropHref="/" onRequestClose={() => {}}>
            <ProjectHeaderDeadline projectId={projectId} schedule={emptySchedule} canEdit />
          </ProjectSheet>
        </QueryClientProvider>
      </ProjectQueryRuntimeProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

const trigger = () => document.querySelector<HTMLElement>('[data-testid="project-deadline-trigger"]')!;
const popup = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Deadline"]');
const frame = () => act(async () => { await new Promise<void>((r) => requestAnimationFrame(() => r())); await new Promise<void>((r) => setTimeout(r, 30)); });

async function open() {
  await act(async () => { trigger().click(); await Promise.resolve(); await Promise.resolve(); });
  expect(popup()).not.toBeNull();
  // Focus inside the popup, as when a person is working in the editor.
  const inside = popup()!.querySelector<HTMLElement>("button, input, [tabindex]")!;
  await act(async () => { inside.focus(); await Promise.resolve(); });
  expect(popup()!.contains(document.activeElement)).toBe(true);
}

let stopReclaim: (() => void) | null = null;

beforeEach(() => { (HTMLElement.prototype as unknown as { getAnimations: () => unknown[] }).getAnimations = () => []; stopReclaim = emulateSheetRestoreFocus(popup); host = document.createElement("div"); document.body.appendChild(host); apiPutMock.mockReset(); });
afterEach(async () => {
  stopReclaim?.();
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  runtime?.dispose(); queryClient?.clear(); root = null; host.remove(); document.body.replaceChildren();
});

describe("header Deadline inside the Project sheet — focus on close (#664)", () => {
  it("Escape puts focus on the trigger immediately and after a frame, writing nothing", async () => {
    await mountInSheet();
    await open();
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    await frame();
    expect(document.activeElement).toBe(trigger());
    expect(apiPutMock).not.toHaveBeenCalled();
  });

  it("Cancel puts focus on the trigger immediately and after a frame, writing nothing", async () => {
    await mountInSheet();
    await open();
    const cancel = [...popup()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Cancel")!;
    await act(async () => { cancel.focus(); cancel.click(); });
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    await frame();
    expect(document.activeElement).toBe(trigger());
    expect(apiPutMock).not.toHaveBeenCalled();
  });

  it("Apply (its button disables, so focus is homeless) lands focus on the trigger immediately and after a frame", async () => {
    apiPutMock.mockResolvedValue({ changed: true, current: { ...emptySchedule, version: 1, source: "manual", state: "scheduled", deadline: { localCivil: "2027-01-15T09:00", zone: "Australia/Sydney", utcOffsetMinutes: 660, fold: 0, instant: "2027-01-14T22:00:00.000Z" }, reminderOffsetsMinutes: [1440] }, eventIntent: null, publicationIds: [] });
    await mountInSheet();
    await open();
    await pickPopupDateTime(popup()!, "2027-01-15T09:00");
    await applyPopup(popup()!);
    await act(async () => { await new Promise<void>((r) => setTimeout(r, 0)); });
    expect(apiPutMock).toHaveBeenCalledTimes(1);
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    await frame();
    expect(document.activeElement).toBe(trigger());
  });
});
