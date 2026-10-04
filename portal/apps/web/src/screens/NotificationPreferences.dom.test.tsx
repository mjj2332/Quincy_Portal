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
  apiGetMock.mockReset().mockResolvedValue({ projectDeadlineReminderEmails: true, subtaskReminderEmails: true, emailDigestCadence: "twice_daily" });
  apiPatchMock.mockReset().mockResolvedValue({ projectDeadlineReminderEmails: false, subtaskReminderEmails: true, emailDigestCadence: "twice_daily" });
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
    expect([...host.querySelectorAll("h2")].map((h) => h.textContent)).toContain("Project deadlines");
    expect(host.textContent).toContain("Always on");
    expect(host.textContent).toContain("In-app reminders always arrive in your notification bell.");
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  });

  it("renders a second Checklist item reminders card whose switch saves only its own preference", async () => {
    const host = document.body.firstElementChild as HTMLElement;
    await act(async () => { root!.render(<NotificationPreferences />); await Promise.resolve(); });
    await flush();
    const headings = [...host.querySelectorAll("h2")].map((h) => h.textContent);
    expect(headings).toEqual(["Email digest", "Project deadlines", "Checklist item reminders"]);
    const second = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!;
    expect(second.checked).toBe(true);
    // The name sits on whichever element is the control (see the accessible-name test below), so match both forms in document order.
    const control = host.querySelector('[aria-label="Checklist item reminder emails"]')!;
    expect(control).not.toBeNull();
    expect(control.getAttribute("aria-labelledby") ?? "").toBe("");
    await act(async () => { second.click(); await Promise.resolve(); });
    expect(apiPatchMock).toHaveBeenCalledWith("/api/notification-preferences", { subtaskReminderEmails: false });
    expect(apiPatchMock).not.toHaveBeenCalledWith("/api/notification-preferences", expect.objectContaining({ projectDeadlineReminderEmails: expect.anything() }));
  });

  it("shows a failed Checklist item save inside its own card and rolls the switch back", async () => {
    apiPatchMock.mockRejectedValueOnce(new ApiError("Subtask save failed", 500));
    const host = document.body.firstElementChild as HTMLElement;
    await act(async () => { root!.render(<NotificationPreferences />); await Promise.resolve(); });
    await flush();
    const second = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!;
    await act(async () => { second.click(); await Promise.resolve(); });
    await flush();
    expect(second.checked).toBe(true);
    const notice = host.querySelector('[data-slot="notice"]')!;
    expect(notice.closest("section")!.querySelector("h2")!.textContent).toBe("Checklist item reminders");
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
    const gate = deferred<{ projectDeadlineReminderEmails: boolean; subtaskReminderEmails: boolean }>();
    apiGetMock.mockReset().mockReturnValue(gate.promise);
    const host = document.body.firstElementChild as HTMLElement;
    await act(async () => { root!.render(<NotificationPreferences />); await Promise.resolve(); });
    // The accessible NAME belongs to the control, not to whichever element happens to implement
    // it. Today the control is a native input and carries the name itself. A composite checkbox
    // (Base UI, Radix) instead renders a visible root with role="checkbox" that carries the name,
    // beside a hidden input that is aria-hidden and so is not in the accessibility tree at all —
    // asserting a name on that input would assert something no screen reader can reach.
    //
    // This selector list matches whichever is present, in document order: the native input today,
    // the widget root after a swap. `disabled` is a different question — it is genuine behaviour,
    // stays on the real input in both worlds, and is queried as such. Decoupled under #50; do not
    // narrow the name query back to `input[type="checkbox"]`.
    const control = () => host.querySelector('input[type="checkbox"], [role="checkbox"]')!;
    const input = () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    //
    // The name assertion alone is NOT enough, and it took a diff review to see why. A composite
    // checkbox auto-detects the wrapping <label> and emits aria-labelledby pointing at it, and
    // aria-labelledby BEATS aria-label — so the control gets announced "Email On" while
    // `getAttribute("aria-label")` still returns the right string and this test stays green.
    // That is a false green over a real regression, so the absence of a competing label
    // reference is pinned too. Empty string and null are both "no reference".
    const labelledBy = () => control().getAttribute("aria-labelledby") ?? "";
    expect(control().getAttribute("aria-label")).toBe("Project deadline reminder emails");
    expect(labelledBy()).toBe("");
    expect(input().disabled).toBe(true);
    await act(async () => { gate.resolve({ projectDeadlineReminderEmails: true, subtaskReminderEmails: true }); await Promise.resolve(); await Promise.resolve(); });
    expect(control().getAttribute("aria-label")).toBe("Project deadline reminder emails");
    expect(labelledBy()).toBe("");
    expect(input().disabled).toBe(false);
  });

  it("shows the optimistic value and disables the control while a save is in flight", async () => {
    const gate = deferred<{ projectDeadlineReminderEmails: boolean; subtaskReminderEmails: boolean }>();
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
    await act(async () => { gate.resolve({ projectDeadlineReminderEmails: false, subtaskReminderEmails: true }); await Promise.resolve(); await Promise.resolve(); });
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
    const gate = deferred<{ projectDeadlineReminderEmails: boolean; subtaskReminderEmails: boolean }>();
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
    await act(async () => { gate.resolve({ projectDeadlineReminderEmails: false, subtaskReminderEmails: true }); await Promise.resolve(); await Promise.resolve(); });
    expect(region.textContent).toBe("");
  });

  it("does not throw after unmount when the deferred GET resolves late, and keeps the active-flag cleanup guard in source (§9.1 test 6)", async () => {
    // Runtime half: a smoke test, not a guard. React 19.2.8 silently ignores a post-unmount
    // state update rather than warning (unlike React 17/18), so this alone would still pass if
    // every `if (active)` guard were deleted.
    const gate = deferred<{ projectDeadlineReminderEmails: boolean; subtaskReminderEmails: boolean }>();
    apiGetMock.mockReset().mockReturnValue(gate.promise);
    await act(async () => { root!.render(<NotificationPreferences />); await Promise.resolve(); });
    await act(async () => { root!.unmount(); await Promise.resolve(); });
    root = null;
    await expect(
      act(async () => { gate.resolve({ projectDeadlineReminderEmails: true, subtaskReminderEmails: true }); await Promise.resolve(); await Promise.resolve(); }),
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
    // The flag and its cleanup are not the guard — the three `if (active)` checks are. Asserting
    // only the first two passes even with every guard deleted (Sol, diff review): assert each
    // guarded continuation by name, and that there are exactly three of them.
    expect(source.match(/if \(active\)/g)).toHaveLength(5);
    expect(source).toContain("if (active) setEnabled(value.projectDeadlineReminderEmails)");
    expect(source).toContain("if (active) setSubtaskEnabled(value.subtaskReminderEmails)");
    expect(source).toContain("if (active) setCadence(");
    expect(source).toContain("if (active) setLoadError(");
    expect(source).toContain("if (active) setLoading(false)");
  });

  it("reports a failed load once at page level and shows neither card as On", async () => {
    apiGetMock.mockReset().mockRejectedValue(new Error("Load failed"));
    const host = document.body.firstElementChild as HTMLElement;
    await act(async () => { root!.render(<NotificationPreferences />); await Promise.resolve(); });
    await flush();
    const notices = [...host.querySelectorAll('[data-slot="notice"]')];
    expect(notices).toHaveLength(1);
    expect(notices[0]!.textContent).toContain("Load failed");
    expect(notices[0]!.closest("section")).toBeNull();
    expect(host.textContent).not.toMatch(/\bOn\b/);
    const boxes = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    for (const box of boxes) { expect(box.checked).toBe(false); expect(box.disabled).toBe(true); }
  });

  it("keeps the Deadline switch enabled while the Checklist save is pending", async () => {
    const gate = deferred<{ projectDeadlineReminderEmails: boolean; subtaskReminderEmails: boolean }>();
    apiPatchMock.mockReset().mockReturnValue(gate.promise);
    const host = document.body.firstElementChild as HTMLElement;
    await act(async () => { root!.render(<NotificationPreferences />); await Promise.resolve(); });
    await flush();
    const [first, second] = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') as unknown as HTMLInputElement[];
    await act(async () => { second!.click(); await Promise.resolve(); });
    expect(second!.disabled).toBe(true);
    expect(first!.disabled).toBe(false);
    await act(async () => { gate.resolve({ projectDeadlineReminderEmails: true, subtaskReminderEmails: false }); await Promise.resolve(); await Promise.resolve(); });
    expect(second!.disabled).toBe(false);
  });

  it("states the in-app note once at page level and a parallel when-footnote per card", async () => {
    const host = document.body.firstElementChild as HTMLElement;
    await act(async () => { root!.render(<NotificationPreferences />); await Promise.resolve(); });
    await flush();
    const note = "In-app reminders always arrive in your notification bell.";
    expect(host.textContent!.split(note)).toHaveLength(2);
    expect(host.querySelector("section")!.textContent).not.toContain(note);
    const [, deadline, checklist] = [...host.querySelectorAll("section")];
    expect(deadline!.textContent).toContain("Sent before and when a Project's deadline is due.");
    expect(checklist!.textContent).toContain("Sent for checklist items assigned to you, before and when they're due.");
  });

  describe("Email digest cadence (#489)", () => {
    const trigger = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('section [role="combobox"]')!;
    const option = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].find((element) => element.textContent === label) ?? null;
    async function renderLoaded() {
      const host = document.body.firstElementChild as HTMLElement;
      await act(async () => { root!.render(<NotificationPreferences />); await Promise.resolve(); });
      await flush();
      return host;
    }

    it("names the combobox from the visible Frequency label, with no separate aria-label, and a touch-sized trigger at phone width", async () => {
      const host = await renderLoaded();
      const combobox = trigger(host);
      const labelIds = (combobox.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
      expect(labelIds.length).toBeGreaterThan(0);
      expect(labelIds.map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim()).toBe("Frequency");
      expect(combobox.hasAttribute("aria-label")).toBe(false);
      expect(combobox.className).toContain("max-[721px]:min-h-[44px]");
    });

    it("shows the stored cadence, with Twice daily as the default", async () => {
      const host = await renderLoaded();
      expect(trigger(host).textContent).toContain("Twice daily (8:00 am and 2:00 pm)");
      expect(host.querySelector("section")!.querySelector("h2")!.textContent).toBe("Email digest");
      expect(host.querySelector("section")!.textContent).toContain("Sydney time");
    });

    it("shows a stored cadence other than the default", async () => {
      apiGetMock.mockReset().mockResolvedValue({ projectDeadlineReminderEmails: true, subtaskReminderEmails: true, emailDigestCadence: "daily" });
      const host = await renderLoaded();
      expect(trigger(host).textContent).toContain("Daily (8:00 am)");
    });

    it("offers the four cadences", async () => {
      const host = await renderLoaded();
      await act(async () => { trigger(host).click(); await Promise.resolve(); });
      const labels = [...document.querySelectorAll('[role="listbox"] [role="option"]')].map((element) => element.textContent);
      expect(labels).toEqual(["Immediately", "Hourly", "Twice daily (8:00 am and 2:00 pm)", "Daily (8:00 am)"]);
    });

    it("saves only the cadence, leaving both reminder switches out of the PATCH", async () => {
      apiPatchMock.mockReset().mockResolvedValue({ projectDeadlineReminderEmails: true, subtaskReminderEmails: true, emailDigestCadence: "hourly" });
      const host = await renderLoaded();
      await act(async () => { trigger(host).click(); await Promise.resolve(); });
      await act(async () => { option("Hourly")!.click(); await Promise.resolve(); });
      await flush();
      expect(apiPatchMock).toHaveBeenCalledExactlyOnceWith("/api/notification-preferences", { emailDigestCadence: "hourly" });
      expect(trigger(host).textContent).toContain("Hourly");
    });

    it("rolls the cadence back and shows the error inside its own card when saving fails", async () => {
      apiPatchMock.mockReset().mockRejectedValueOnce(new ApiError("Cadence save failed", 500));
      const host = await renderLoaded();
      await act(async () => { trigger(host).click(); await Promise.resolve(); });
      await act(async () => { option("Immediately")!.click(); await Promise.resolve(); });
      await flush();
      expect(trigger(host).textContent).toContain("Twice daily (8:00 am and 2:00 pm)");
      const notice = host.querySelector('[data-slot="notice"]')!;
      expect(notice.textContent).toContain("Cadence save failed");
      expect(notice.closest("section")!.querySelector("h2")!.textContent).toBe("Email digest");
    });

    it("disables the cadence control while it loads and when the load failed", async () => {
      const gate = deferred<unknown>();
      apiGetMock.mockReset().mockReturnValue(gate.promise);
      const host = document.body.firstElementChild as HTMLElement;
      await act(async () => { root!.render(<NotificationPreferences />); await Promise.resolve(); });
      expect(trigger(host).disabled).toBe(true);
      await act(async () => { gate.reject(new Error("Load failed")); await Promise.resolve(); await Promise.resolve(); });
      expect(trigger(host).disabled).toBe(true);
    });

    it("keeps the reminder switches usable while the cadence save is pending", async () => {
      const gate = deferred<unknown>();
      apiPatchMock.mockReset().mockReturnValue(gate.promise);
      const host = await renderLoaded();
      await act(async () => { trigger(host).click(); await Promise.resolve(); });
      await act(async () => { option("Daily (8:00 am)")!.click(); await Promise.resolve(); });
      expect(trigger(host).disabled).toBe(true);
      const boxes = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      for (const box of boxes) expect(box.disabled).toBe(false);
      await act(async () => { gate.resolve({ projectDeadlineReminderEmails: true, subtaskReminderEmails: true, emailDigestCadence: "daily" }); await Promise.resolve(); await Promise.resolve(); });
      expect(trigger(host).disabled).toBe(false);
    });
  });
});
