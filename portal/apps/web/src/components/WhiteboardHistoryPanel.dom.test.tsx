/**
 * #500 (client): the whiteboard's History panel. Versions come from GET /whiteboard/versions (newest first), Restore asks first (the current board
 * is backed up automatically), posts `requestId` + `expectedGeneration`, and a stale generation refetches. View-only boards list but cannot restore.
 * Guard F: every hook is a `data-testid` or an aria-label this code authors; no vendor `data-slot` selectors.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toasts: [] as Array<[string, string | undefined]> }));
vi.mock("../lib/api", async (original) => ({ ...(await original<typeof import("../lib/api")>()), apiGet: h.get, apiPost: h.post }));
vi.mock("../lib/toast-store", () => ({ pushToast: (message: string, tone?: string) => { h.toasts.push([message, tone]); } }));

import { ApiError } from "../lib/api";
import { HISTORY_REFRESH_QUIET_MS, WhiteboardHistoryPanel } from "./WhiteboardHistoryPanel";

const version = (id: string, createdAt: number, reason: "interval" | "last_leave" | "pre_restore", elementCount: number, name: string | null = "Terry Lee") => ({ id, createdAt, createdBy: name ? { id: "u1", name } : null, reason, elementCount, byteCount: 100 });
const listing = (generation = 3) => ({ generation, versions: [version("v-old", 1_000_000, "interval", 2), version("v-new", 9_000_000, "last_leave", 7), version("v-mid", 5_000_000, "pre_restore", 5, null)] });

let host: HTMLDivElement;
let root: Root;
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };
const props = (over: Partial<Parameters<typeof WhiteboardHistoryPanel>[0]> = {}) => ({ projectId: "p1", title: "1 Writes Street", open: true, onOpenChange: () => undefined, readOnly: false, onRestoreStarted: vi.fn(), onRestoreFailed: vi.fn(), ...over });
async function render(p: ReturnType<typeof props>) { await act(async () => { root.render(<WhiteboardHistoryPanel {...p} />); }); await flush(); }
const byLabel = (label: string) => document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const byId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (element: HTMLElement | null) => { await act(async () => { element!.click(); await Promise.resolve(); }); await flush(); };

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.toasts.length = 0;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); document.body.replaceChildren(); });

describe("WhiteboardHistoryPanel (#500)", () => {
  it("fetches nothing while closed, then lists the versions newest first with reason, author and element count", async () => {
    h.get.mockResolvedValue(listing());
    await render(props({ open: false }));
    expect(h.get).not.toHaveBeenCalled();
    await render(props({ open: true }));
    expect(h.get).toHaveBeenCalledWith("/api/projects/p1/whiteboard/versions");
    const rows = [...document.body.querySelectorAll<HTMLElement>('[data-testid="whiteboard-version-row"]')];
    expect(rows.map((row) => row.getAttribute("data-version-id"))).toEqual(["v-new", "v-mid", "v-old"]);
    expect(rows[0]!.textContent).toContain("7 elements");
    expect(rows[0]!.textContent).toContain("Terry");
    expect(rows[1]!.textContent).toContain("Before restore");
    expect(rows[2]!.textContent).toContain("2 elements");
  });

  it("puts the element count in the title's badge slot, not in the meta line, so a narrow row cannot push it out", async () => {
    h.get.mockResolvedValue(listing());
    await render(props());
    const row = document.body.querySelector<HTMLElement>('[data-testid="whiteboard-version-row"][data-version-id="v-new"]')!;
    const count = row.querySelector<HTMLElement>('[data-testid="whiteboard-version-count"]');
    expect(count).not.toBeNull();
    expect(count!.textContent).toBe("7 elements");
    expect(count!.closest("p")).toBeNull();                      // the meta line is the row's <p> description
    expect(row.querySelector("p")!.textContent).not.toContain("elements");
  });

  it("shows loading rows, then the empty state when there is no history yet", async () => {
    let resolve!: (value: unknown) => void;
    h.get.mockReturnValue(new Promise((r) => { resolve = r; }));
    await render(props());
    expect(byId("whiteboard-history-loading")).not.toBeNull();
    await act(async () => { resolve({ generation: 1, versions: [] }); }); await flush();
    expect(byId("whiteboard-history-loading")).toBeNull();
    expect(byId("whiteboard-history-empty")).not.toBeNull();
  });

  it("shows an error with Try again, which fetches again", async () => {
    h.get.mockRejectedValueOnce(new ApiError("boom", 500)).mockResolvedValueOnce(listing());
    await render(props());
    expect(byId("whiteboard-history-error")).not.toBeNull();
    await click(byId("whiteboard-history-retry"));
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(byId("whiteboard-history-error")).toBeNull();
    expect(document.body.querySelectorAll('[data-testid="whiteboard-version-row"]')).toHaveLength(3);
  });

  it("view-only: the list is visible and no Restore action exists", async () => {
    h.get.mockResolvedValue(listing());
    await render(props({ readOnly: true }));
    expect(document.body.querySelectorAll('[data-testid="whiteboard-version-row"]')).toHaveLength(3);
    expect(document.body.querySelector('[aria-label^="Restore "]')).toBeNull();
  });

  it("Restore asks first, explaining the automatic backup, and posts the requestId and expectedGeneration only on confirm", async () => {
    h.get.mockResolvedValue(listing(3));
    h.post.mockResolvedValue({ ok: true, generation: 4, versionId: "v-new", backupVersionId: "b1" });
    const p = props(); await render(p);
    await click(document.body.querySelector<HTMLElement>('[data-version-id="v-new"] [aria-label^="Restore "]'));
    const confirm = byId("whiteboard-restore-confirm");
    expect(confirm).not.toBeNull();
    expect(confirm!.textContent).toMatch(/backup/i);
    expect(h.post).not.toHaveBeenCalled();
    await click(byId("whiteboard-restore-confirm-action"));
    expect(p.onRestoreStarted).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenCalledTimes(1);
    const [path, body] = h.post.mock.calls[0]!;
    expect(path).toBe("/api/projects/p1/whiteboard/versions/v-new/restore");
    expect(body).toEqual({ expectedGeneration: 3, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(p.onRestoreFailed).not.toHaveBeenCalled();
  });

  it("Cancel posts nothing", async () => {
    h.get.mockResolvedValue(listing());
    await render(props());
    await click(document.body.querySelector<HTMLElement>('[data-version-id="v-new"] [aria-label^="Restore "]'));
    await click(byId("whiteboard-restore-confirm-cancel"));
    expect(h.post).not.toHaveBeenCalled();
    expect(byId("whiteboard-restore-confirm")).toBeNull();
  });

  it("a stale generation refetches the list and says so, and the restore is reported as not started", async () => {
    h.get.mockResolvedValueOnce(listing(3)).mockResolvedValueOnce(listing(4));
    h.post.mockRejectedValue(new ApiError("The board changed since this history was loaded.", 409, { code: "stale_generation", generation: 4 }));
    const p = props(); await render(p);
    await click(document.body.querySelector<HTMLElement>('[data-version-id="v-new"] [aria-label^="Restore "]'));
    await click(byId("whiteboard-restore-confirm-action"));
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(p.onRestoreFailed).toHaveBeenCalledTimes(1);
    expect(h.toasts.some(([message, tone]) => /changed|restored/i.test(message) && tone === "error")).toBe(true);
    // The next restore expects the generation that refetch returned.
    h.post.mockResolvedValue({ ok: true, generation: 5, versionId: "v-new", backupVersionId: "b" });
    await click(document.body.querySelector<HTMLElement>('[data-version-id="v-new"] [aria-label^="Restore "]'));
    await click(byId("whiteboard-restore-confirm-action"));
    expect(h.post.mock.calls.at(-1)![1]).toMatchObject({ expectedGeneration: 4 });
  });

  it("any other failure reports it and leaves the board's restore flag cleared", async () => {
    h.get.mockResolvedValue(listing());
    h.post.mockRejectedValue(new ApiError("An Archived Project's board cannot be restored.", 409, { code: "archived" }));
    const p = props(); await render(p);
    await click(document.body.querySelector<HTMLElement>('[data-version-id="v-new"] [aria-label^="Restore "]'));
    await click(byId("whiteboard-restore-confirm-action"));
    expect(p.onRestoreFailed).toHaveBeenCalledTimes(1);
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(h.toasts).toContainEqual(["An Archived Project's board cannot be restored.", "error"]);
  });

  it("Cancel and Escape return focus to that row's Restore button, not the sheet's tab (#500 browser pass)", async () => {
    h.get.mockResolvedValue(listing());
    await render(props());
    const restoreFor = () => document.body.querySelector<HTMLElement>('[data-version-id="v-mid"] [aria-label^="Restore "]')!;
    await click(restoreFor());
    await click(byId("whiteboard-restore-confirm-cancel"));
    expect(document.activeElement).toBe(restoreFor());
    await click(restoreFor());
    await act(async () => { byId("whiteboard-restore-confirm")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await Promise.resolve(); });
    await flush();
    expect(byId("whiteboard-restore-confirm")).toBeNull();
    expect(document.activeElement).toBe(restoreFor());
  });

  it("touch: the Restore action and Try Again are 44px at <=721px (#500 browser pass, #559)", async () => {
    h.get.mockResolvedValue(listing());
    await render(props());
    const restore = document.body.querySelector<HTMLElement>('[aria-label^="Restore "]')!;
    expect(restore.className).toContain("max-[721px]:min-h-[44px]");
    expect(restore.className).toContain("max-[721px]:min-w-[44px]");
  });

  it("Try Again is the default button size, whose floor is 44px on phones, not the 28px sm (#559)", async () => {
    h.get.mockRejectedValue(new ApiError("nope", 500, undefined));
    await render(props());
    const retry = byId("whiteboard-history-retry")!;
    expect(retry.className).toContain("max-[721px]:min-h-[44px]");
    expect(retry.className).not.toContain("h-7");
  });

  it("History is said once: the title is History, the subtitle is the address, and a lone pane has no tab strip (#559)", async () => {
    h.get.mockResolvedValue(listing());
    await render(props());
    const sheet = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    const named = (attribute: string) => document.getElementById(sheet.getAttribute(attribute) ?? "")?.textContent;
    expect(named("aria-labelledby")).toBe("History");
    expect(named("aria-describedby")).toBe("1 Writes Street");
    expect(sheet.querySelector('[role="tablist"]')).toBeNull();
    expect(sheet.querySelector('[role="tab"]')).toBeNull();
    expect(sheet.querySelectorAll('[data-testid="whiteboard-version-row"]')).toHaveLength(3);
  });

  it("marks the version the live board equals as Current, with no Restore on it (#559)", async () => {
    h.get.mockResolvedValue({ ...listing(), currentVersionId: "v-new" });
    await render(props());
    const rowOf = (id: string) => document.body.querySelector<HTMLElement>(`[data-version-id="${id}"]`)!;
    expect(rowOf("v-new").querySelector('[data-testid="whiteboard-version-current"]')?.textContent).toBe("Current");
    expect(rowOf("v-new").hasAttribute("data-current")).toBe(true);
    expect(rowOf("v-new").querySelector('[data-testid="whiteboard-version-current"]')!.className).toContain("rounded-full");
    // The count never wraps ("0 elements" stays on one line) and a long title clips instead of squeezing it.
    for (const id of ["v-new", "v-mid", "v-old"]) {
      const count = rowOf(id).querySelector<HTMLElement>('[data-testid="whiteboard-version-count"]')!;
      expect(count.className).toContain("whitespace-nowrap");
      expect(count.className).toContain("shrink-0");
    }
    expect(rowOf("v-new").querySelector('[aria-label^="Restore "]')).toBeNull();
    for (const id of ["v-mid", "v-old"]) {
      expect(rowOf(id).querySelector('[data-testid="whiteboard-version-current"]')).toBeNull();
      expect(rowOf(id).querySelector('[aria-label^="Restore "]')).not.toBeNull();
    }
  });

  it("marks nothing when the board has changed since its last snapshot, or the server names none (#559)", async () => {
    h.get.mockResolvedValue({ ...listing(), currentVersionId: null });
    await render(props());
    expect(document.body.querySelector('[data-testid="whiteboard-version-current"]')).toBeNull();
  });

  it("the Current marker follows the board: a change while open refreshes the list once it settles, without a loading flash (#559)", async () => {
    vi.useFakeTimers();
    try {
      h.get.mockResolvedValue({ ...listing(), currentVersionId: "v-new" });
      const changes: { current: (() => void) | null } = { current: null };
      await render(props({ changes }));
      const current = () => document.body.querySelector('[data-testid="whiteboard-version-current"]')?.closest("[data-version-id]")?.getAttribute("data-version-id") ?? null;
      expect(current()).toBe("v-new");
      expect(changes.current).not.toBeNull();
      // A burst of strokes is ONE read, after the quiet period.
      h.get.mockClear();
      h.get.mockResolvedValue({ ...listing(), currentVersionId: null });
      for (let n = 0; n < 5; n += 1) { changes.current!(); await act(async () => { await vi.advanceTimersByTimeAsync(HISTORY_REFRESH_QUIET_MS - 100); }); }
      expect(h.get).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      await flush();
      expect(h.get).toHaveBeenCalledTimes(1);
      expect(byId("whiteboard-history-loading")).toBeNull();
      expect(current()).toBeNull();
      expect(document.body.querySelector('[data-version-id="v-new"] [aria-label^="Restore "]')).not.toBeNull();
      // Closing drops the hook and any pending read.
      changes.current!();
      await render(props({ changes, open: false }));
      expect(changes.current).toBeNull();
      h.get.mockClear();
      await act(async () => { await vi.advanceTimersByTimeAsync(HISTORY_REFRESH_QUIET_MS * 2); });
      expect(h.get).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("a single pane is plain content: no focusable unnamed tabpanel (#559)", async () => {
    h.get.mockResolvedValue(listing());
    await render(props());
    const sheet = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(sheet.querySelector('[role="tabpanel"]')).toBeNull();
    expect(sheet.querySelector('[role="tablist"]')).toBeNull();
    expect(sheet.querySelector('[data-testid="whiteboard-version-row"]')).not.toBeNull();
  });

  it("two versions saved in the same minute read apart, in Sydney time (#559)", async () => {
    const minute = Date.parse("2020-03-10T05:04:00.000Z");
    h.get.mockResolvedValue({ generation: 1, currentVersionId: null, versions: [version("late", minute + 50_000, "last_leave", 4), version("early", minute + 5_000, "interval", 3), version("older", minute - 7_200_000, "interval", 2)] });
    await render(props());
    const when = (id: string) => document.body.querySelector<HTMLElement>(`[data-version-id="${id}"]`)!.textContent!;
    expect(when("late")).toContain("10 Mar 2020, 4:04:50 PM");
    expect(when("early")).toContain("10 Mar 2020, 4:04:05 PM");
    expect(when("older")).toContain("10 Mar 2020, 2:04 PM");
    expect(when("older")).not.toContain("2:04:00");
  });

  it("the sheet's own width wins over the registry's w-3/4 (320px, capped to the viewport) (#500 browser pass)", async () => {
    h.get.mockResolvedValue(listing());
    await render(props());
    const sheet = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(sheet.className).toContain("data-[side=right]:w-[min(20rem,calc(100%-3rem))]");
    expect(sheet.className).not.toContain("data-[side=right]:w-3/4");
  });

  it("a network failure shows a human message, never the raw fetch error (#500 browser pass)", async () => {
    h.get.mockRejectedValue(new ApiError("Failed to fetch", 0, new TypeError("Failed to fetch")));
    await render(props());
    const text = byId("whiteboard-history-error")!.textContent!;
    expect(text).not.toContain("Failed to fetch");
    expect(text).toMatch(/connection/i);
    // and a restore that fails the same way toasts the same way
    h.get.mockResolvedValue(listing());
    await click(byId("whiteboard-history-retry"));
    h.post.mockRejectedValue(new ApiError("Failed to fetch", 0, new TypeError("Failed to fetch")));
    await click(document.body.querySelector<HTMLElement>('[data-version-id="v-new"] [aria-label^="Restore "]'));
    await click(byId("whiteboard-restore-confirm-action"));
    expect(h.toasts.map(([message]) => message).join("|")).not.toContain("Failed to fetch");
  });

  it("the byline's avatar initials come from the same name it shows (QA Test Account: QT, full name) (#500 browser pass)", async () => {
    h.get.mockResolvedValue({ generation: 1, versions: [version("v1", 1_000_000, "interval", 1, "QA Test Account")] });
    await render(props());
    const row = document.body.querySelector<HTMLElement>('[data-testid="whiteboard-version-row"]')!;
    expect(row.textContent).toContain("QA Test Account");
    expect(row.textContent).toContain("QT");
  });
});
