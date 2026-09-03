import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { NotificationPreferences } from "./NotificationPreferences";

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPatchMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPatch: (path: string, body: unknown) => apiPatchMock(path, body) };
});

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

// A promise the test controls the settlement of, so "in flight" states (loading, saving) can be
// observed before resolution rather than inferred from an already-settled mock.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  apiGetMock.mockReset().mockResolvedValue({ projectDeadlineReminderEmails: true });
  apiPatchMock.mockReset().mockResolvedValue({ projectDeadlineReminderEmails: false });
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null; document.body.replaceChildren();
});

describe("NotificationPreferences", () => {
  it("loads the default and states that in-app reminders are mandatory", async () => {
    const host = document.body.firstElementChild as HTMLElement;
    await act(async () => { root!.render(<NotificationPreferences />); await Promise.resolve(); });
    await flush();
    expect(apiGetMock).toHaveBeenCalledWith("/api/notification-preferences");
    // Scoped to the heading on purpose (§9.1): the checkbox keeps the longer aria-label, so an
    // unscoped toContain would pass on that alone even if the heading itself were deleted.
    expect(host.querySelector("h2")!.textContent).toBe("Project deadlines");
    expect(host.textContent).toContain("Always on");
    expect(host.textContent).toContain("In-app reminders always arrive in your notification bell.");
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  });

  it("rolls an optimistic toggle back to the authoritative value when saving fails", async () => {
    apiPatchMock.mockRejectedValueOnce(new ApiError("Preference save failed", 500));
    const host = document.body.firstElementChild as HTMLElement;
    await act(async () => { root!.render(<NotificationPreferences />); await Promise.resolve(); });
    await flush();
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => { checkbox.click(); await Promise.resolve(); });
    expect(apiPatchMock).toHaveBeenCalledWith("/api/notification-preferences", { projectDeadlineReminderEmails: false });
    await flush();
    expect(checkbox.checked).toBe(true);
    expect(host.textContent).toContain("Preference save failed");
  });

  it("keeps the checkbox's accessible name in the loading state and after it", async () => {
    const gate = deferred<{ projectDeadlineReminderEmails: boolean }>();
    apiGetMock.mockReset().mockReturnValue(gate.promise);
    const host = document.body.firstElementChild as HTMLElement;
    await act(async () => { root!.render(<NotificationPreferences />); await Promise.resolve(); });
    const whileLoading = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(whileLoading.getAttribute("aria-label")).toBe("Project deadline reminder emails");
    expect(whileLoading.disabled).toBe(true);
    await act(async () => { gate.resolve({ projectDeadlineReminderEmails: true }); await Promise.resolve(); await Promise.resolve(); });
    const afterLoad = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(afterLoad.getAttribute("aria-label")).toBe("Project deadline reminder emails");
    expect(afterLoad.disabled).toBe(false);
  });

  it("shows the optimistic value and disables the control while a save is in flight", async () => {
    const gate = deferred<{ projectDeadlineReminderEmails: boolean }>();
    apiPatchMock.mockReset().mockReturnValue(gate.promise);
    const host = document.body.firstElementChild as HTMLElement;
    await act(async () => { root!.render(<NotificationPreferences />); await Promise.resolve(); });
    await flush();
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(true);
    await act(async () => { checkbox.click(); await Promise.resolve(); });
    // The rollback test above proves the *rollback*; this proves the *optimistic* state the
    // promise's settlement hides there — checked is already false before the PATCH resolves.
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.closest("span")!.textContent).toContain("Saving…");
    await act(async () => { gate.resolve({ projectDeadlineReminderEmails: false }); await Promise.resolve(); await Promise.resolve(); });
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.closest("span")!.textContent).toContain("Off");
  });

  it("renders the save error inside the card, not as a page-level sibling", async () => {
    apiPatchMock.mockRejectedValueOnce(new ApiError("Preference save failed", 500));
    const host = document.body.firstElementChild as HTMLElement;
    await act(async () => { root!.render(<NotificationPreferences />); await Promise.resolve(); });
    await flush();
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => { checkbox.click(); await Promise.resolve(); });
    await flush();
    const notice = host.querySelector('[data-slot="notice"]');
    expect(notice).not.toBeNull();
    const card = notice!.closest("section");
    expect(card).not.toBeNull();
    expect(card!.querySelector("h2")!.textContent).toBe("Project deadlines");
  });

  it("toggles the checkbox when the row's label text is clicked", async () => {
    const host = document.body.firstElementChild as HTMLElement;
    await act(async () => { root!.render(<NotificationPreferences />); await Promise.resolve(); });
    await flush();
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(true);
    const label = checkbox.closest("label")!;
    const eyebrow = label.querySelector('[data-slot="eyebrow"]') as HTMLElement;
    await act(async () => { eyebrow.click(); await Promise.resolve(); });
    expect(apiPatchMock).toHaveBeenCalledWith("/api/notification-preferences", { projectDeadlineReminderEmails: false });
  });

  it("marks the live region polite and states exactly one thing while saving", async () => {
    const gate = deferred<{ projectDeadlineReminderEmails: boolean }>();
    apiPatchMock.mockReset().mockReturnValue(gate.promise);
    const host = document.body.firstElementChild as HTMLElement;
    await act(async () => { root!.render(<NotificationPreferences />); await Promise.resolve(); });
    await flush();
    const region = host.querySelector("[aria-live]")!;
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => { checkbox.click(); await Promise.resolve(); });
    expect(region.textContent).toBe("Saving notification preferences");
    await act(async () => { gate.resolve({ projectDeadlineReminderEmails: false }); await Promise.resolve(); await Promise.resolve(); });
    expect(region.textContent).toBe("");
  });

  it("does not throw after unmount when the deferred GET resolves late, and keeps the active-flag cleanup guard in source (§9.1 test 6)", async () => {
    // Runtime half: a smoke test, not a guard. React 19.2.8 silently ignores a post-unmount
    // state update rather than warning (unlike React 17/18), so this alone would still pass if
    // every `if (active)` guard were deleted.
    const gate = deferred<{ projectDeadlineReminderEmails: boolean }>();
    apiGetMock.mockReset().mockReturnValue(gate.promise);
    await act(async () => { root!.render(<NotificationPreferences />); await Promise.resolve(); });
    await act(async () => { root!.unmount(); await Promise.resolve(); });
    root = null;
    await expect(
      act(async () => { gate.resolve({ projectDeadlineReminderEmails: true }); await Promise.resolve(); await Promise.resolve(); }),
    ).resolves.not.toThrow();

    // The actual guard: a source-level assertion (same form as §9.3 test 4) that the effect
    // still declares the `active` flag and its cleanup return — happy-dom plus React 19 leave no
    // observable behavioural difference the runtime half above could assert on instead.
    // happy-dom's global `URL` does not resolve a relative path against a `file:` base
    // correctly (it substitutes its own emulated page location), so the path is built with
    // `node:path` against this test file's own absolute path instead of `new URL(rel, base)`.
    const sourcePath = join(dirname(fileURLToPath(import.meta.url)), "NotificationPreferences.tsx");
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toMatch(/let active = true;/);
    expect(source).toContain("return () => { active = false; };");
  });
});
