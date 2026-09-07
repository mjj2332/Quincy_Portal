import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../lib/api";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";
import { projectDataKeys } from "../lib/project-data";
import type { ProjectDeadlineSchedule } from "@quincy/shared";

const apiPutMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
const confirmMock = vi.hoisted(() => vi.fn<(options: unknown) => Promise<boolean>>());

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiPut: (path: string, body: unknown) => apiPutMock(path, body) };
});
vi.mock("../lib/confirm", () => ({ confirm: confirmMock }));

const projectId = "11111111-1111-4111-8111-111111111111";
const deadline = { localCivil: "2027-01-15T09:00", zone: "Australia/Sydney" as const, utcOffsetMinutes: 600, fold: 0 as const, instant: "2027-01-14T22:00:00.000Z" };
const emptySchedule: ProjectDeadlineSchedule = { version: 0, deadline: null, reminderOffsetsMinutes: [], state: "unset", nextOccurrence: null, canResume: false };
const activeSchedule: ProjectDeadlineSchedule = { version: 1, deadline, reminderOffsetsMinutes: [1440], state: "scheduled", nextOccurrence: { kind: "advance", offsetMinutes: 1440, firesAt: "2027-01-13T22:00:00.000Z" }, canResume: false };
const authorityAfterConflict: ProjectDeadlineSchedule = { version: 2, deadline: { localCivil: "2027-02-20T10:00", zone: "Australia/Sydney", utcOffsetMinutes: 660, fold: 0, instant: "2027-02-19T23:00:00.000Z" }, reminderOffsetsMinutes: [240], state: "scheduled", nextOccurrence: { kind: "advance", offsetMinutes: 240, firesAt: "2027-02-19T19:00:00.000Z" }, canResume: false };
const savedDraftSchedule: ProjectDeadlineSchedule = { version: 3, deadline: { localCivil: "2026-04-05T02:30", zone: "Australia/Sydney", utcOffsetMinutes: 600, fold: 1, instant: "2026-04-04T16:30:00.000Z" }, reminderOffsetsMinutes: [1440], state: "scheduled", nextOccurrence: { kind: "advance", offsetMinutes: 1440, firesAt: "2026-04-03T16:30:00.000Z" }, canResume: false };
const summarySchedule: ProjectDeadlineSchedule = { ...activeSchedule, reminderOffsetsMinutes: [1440, 240, 60], skippedReminderOffsetsMinutes: [1440, 240] };

// Detects whether any class token on a control suppresses the focus outline. Three earlier
// rounds tried to parse the *variant chain* preceding the terminal utility (plain names, bracket
// arbitrary variants, bareword-prefixed arbitrary variants, `/`-named group/peer modifiers) and
// each round found another legitimate Tailwind variant syntax the grammar hadn't anticipated —
// most recently nested-bracket selectors (`[&[data-active]]:outline-none`), which a "brackets
// don't nest" bracket-matching branch structurally cannot represent. Parsing the variant chain is
// the wrong problem: we don't care what a token's variants *are*, only whether its *terminal
// utility* is one of the outline-suppressing ones. So this never parses the variant chain at all
// — it splits the class string into whitespace-separated tokens and, per token, checks only that
// the token *ends* with one of the exact utility spellings in TERMINAL_UTILITY below (each
// optionally wrapped in a single leading/trailing `!important` marker), preceded by either the
// start of the token or a `:`. That trailing anchor is what makes the *chain* handling general:
// whatever sequence of variants (current or future Tailwind syntax, including nested brackets)
// precedes the terminal utility, it either ends in `:` right before the utility or the utility
// *is* the whole token — both cases are covered without needing to understand variant syntax.
//
// The set of utility spellings itself, however, is a deliberately bounded, exact list — NOT an
// unbounded claim to catch "every outline-suppressing form Tailwind allows" (that overclaim is
// what an earlier version of this comment made). Each entry below was verified by actually
// compiling it against the pinned tailwindcss@4.3.3 (via `compile()` from the `tailwindcss`
// package itself, the same engine `@tailwindcss/vite` uses) and inspecting the real generated
// declaration — not assumed from what the class name looks like:
//   - outline-none, outline-hidden          → outline-style: none
//   - outline-0, outline-[0], outline-[0px] → outline-width: 0 / 0px (draws nothing regardless
//                                              of outline-style, which defaults to solid)
//   - [outline-style:none]
//   - [outline-width:0], [outline-width:0px]
//   - [outline:none], [outline:0], [outline:0px]     (arbitrary-property shorthand form)
// One plausible-looking form was checked and deliberately excluded: `outline-[none]` compiles to
// the invalid declaration `outline-color: none`, which does NOT suppress the outline.
//
// SCOPE BOUNDARY — read before adding another case here. This list is exhaustive for one thing
// only: Tailwind's *named* outline-suppressing utilities (`outline-none`, `outline-hidden`) — a
// fixed, versioned vocabulary that only grows when Tailwind ships a new release, so enumerating
// it to completion is a reasonable, closed task (and IS the completeness bar for those two — a
// future Tailwind version adding another such name must be added here explicitly). Everything
// else in the list — `outline-0`, `outline-[0]`, `outline-[0px]`, `[outline-style:none]`,
// `[outline-width:0]`, `[outline-width:0px]`, `[outline:none]`, `[outline:0]`, `[outline:0px]` —
// is NOT a closed vocabulary the same way: these are arbitrary-value/arbitrary-property forms,
// drawn from the very same open-ended CSS spelling space described below, and this list only
// covers a deliberately hand-picked, individually-verified subset of common spellings within
// that space — not that space in full. It deliberately does NOT attempt to recognize every
// CSS-equivalent way to spell zero-length or the color transparent, because neither of those is a
// closed set: zero-length has infinitely many spellings (any CSS unit — px/rem/em/%/vw/... —
// plus arbitrary `calc()` expressions that evaluate to zero), and "transparent" has infinitely
// many spellings too (the `transparent` keyword, hex with a `00` alpha channel, `rgba()`/
// `hsla()` with 0 alpha, `color-mix()` results, a custom property that happens to resolve
// transparent). No finite regex can complete either list, so beyond the hand-picked subset above,
// this detector does not try — `outline-[0rem]`, `outline-transparent`, and their relatives are
// real suppressors that `suppressesOutline()` will return `false` for; see the dedicated "real
// but out-of-scope" group in the matrix test further below for concrete examples, and the comment
// on the "never suppresses the global focus ring…" test further below for why that gap is
// provably harmless for the components this file actually protects.
const TERMINAL_UTILITY = /(?:^|:)!?(?:outline-none|outline-hidden|outline-0|outline-\[0\]|outline-\[0px\]|\[outline-style:none\]|\[outline-width:(?:0|0px)\]|\[outline:(?:none|0|0px)\])!?$/;

function suppressesOutline(className: string) {
  return className.split(/\s+/).some((token) => TERMINAL_UTILITY.test(token));
}

let root: Root | null = null;
let queryClient: QueryClient;
let runtime: ProjectQueryRuntime;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

async function mount(schedule: ProjectDeadlineSchedule, canEdit = true) {
  const host = document.createElement("div"); document.body.appendChild(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  runtime = new ProjectQueryRuntime(queryClient);
  root = createRoot(host);
  const { ProjectDeadlineControl } = await import("./ProjectDeadlineControl");
  await act(async () => { root!.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><ProjectDeadlineControl projectId={projectId} schedule={schedule} canEdit={canEdit} /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); });
  return host;
}

async function rerenderSchedule(schedule: ProjectDeadlineSchedule, canEdit = true) {
  const { ProjectDeadlineControl } = await import("./ProjectDeadlineControl");
  await act(async () => { root!.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><ProjectDeadlineControl projectId={projectId} schedule={schedule} canEdit={canEdit} /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); });
}

async function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); await Promise.resolve(); });
}

beforeEach(() => {
  apiPutMock.mockReset().mockResolvedValue({ changed: true, current: activeSchedule, eventIntent: null, publicationIds: [] });
  confirmMock.mockReset().mockResolvedValue(true);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  runtime.dispose(); queryClient.clear(); root = null; document.body.replaceChildren();
});

describe("ProjectDeadlineControl", () => {
  it("renders the two rail rows read-only and hides write controls for Delivered", async () => {
    const host = await mount({ ...activeSchedule, state: "inactive_delivered" }, true);
    expect(host.querySelectorAll('[data-testid="project-deadline-row"]')).toHaveLength(2);
    expect(host.textContent).toContain("Sydney (Australia/Sydney)");
    expect(host.textContent).toContain("Reminders inactive while Delivered. Move the project out of Delivered before changing or resuming them.");
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });

  it("never suppresses the global focus ring on the open editor's inputs and action buttons", async () => {
    // suppressesOutline()'s bounded detector (see TERMINAL_UTILITY's own comment) does not
    // recognize every CSS-equivalent zero-length or transparent-color spelling — but that gap is
    // provably harmless for what THIS test actually mounts (ProjectDeadlineControl only, via
    // mount(emptySchedule) below), verified by direct source inspection rather than by this
    // test's own generality. Every outline-related class token this component can ever produce is
    // a hardcoded string literal, from one of three sites local to it: (a) rail-field.ts:11-12 —
    // RAIL_FIELD, imported here as DEADLINE_FIELD for the date/time inputs; (b) ui/button.tsx:
    // 27-28 — buttonClasses()'s shared BASE class, applied to every button built through
    // buttonClasses() (Set/Edit Deadline, Cancel, Resume reminders, Add); and (c)
    // ProjectDeadlineControl.tsx:264-265 — the custom reminder chip's own remove button, which is
    // hand-written and does NOT go through buttonClasses(). Of these three, only (a) and (b)
    // actually render in this specific test: emptySchedule has no reminders configured yet, so no
    // custom-reminder chip — and therefore no (c) remove button — exists in this test's DOM; the
    // loop below still checks whichever controls emptySchedule does produce. (ProjectOverviewRail.
    // tsx and CollectionPanel.tsx have their own hardcoded outline literals too, but those belong
    // to separate components this test never mounts — out of scope for this inventory, not part
    // of it.) Each of (a)-(c) keeps the outline visible — `outline-solid` (never `outline-none`/
    // `outline-hidden`), a non-zero `--border-width-bold` outline width (never `0`/`0px`/an
    // out-of-scope zero spelling), `outline-ring` (a real color, never `transparent` or an
    // out-of-scope transparent spelling), and a non-zero offset. None of these three sites
    // construct their outline classes dynamically, so nothing outside this fixed, inspected set
    // can ever reach this test's mounted controls' className.
    const host = await mount(emptySchedule);
    await act(async () => { host.querySelector<HTMLButtonElement>("button")!.click(); await Promise.resolve(); });
    const controls = [...host.querySelectorAll<HTMLElement>("input, button")];
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(suppressesOutline(control.className)).toBe(false);
      expect((control.getAttribute("style") ?? "")).not.toMatch(/outline\s*:\s*(?:none|0)\b/i);
    }
  });

  it("the outline-suppression detector catches every entry in its bounded vocabulary — Tailwind's named outline-suppressing utilities plus a hand-picked, verified set of arbitrary-value/property spellings — never flags legitimate outline-* classes, and — by explicit, documented design — misses real suppressors outside that vocabulary", () => {
    // Three groups, three different claims:
    //  1. `bad` — every class token in TERMINAL_UTILITY's exact, verified, bounded set (see that
    //     constant's own "SCOPE BOUNDARY" comment for the full list, for why it is NOT simply
    //     "every outline-suppressing utility name" — only outline-none/outline-hidden are that;
    //     the rest are a deliberately selected, non-exhaustive sample of arbitrary-value/property
    //     spellings — and for how each entry was confirmed against a real Tailwind compile) must
    //     be caught, under any variant chain no matter how exotic.
    //  2. `legitimate` — a real outline utility that merely starts with "outline-", or contains a
    //     colon inside an arbitrary value, must never false-positive.
    //  3. `realButOutOfScope` — real outline-suppressing classes that use an open-ended CSS
    //     spelling of zero-length or transparent (see TERMINAL_UTILITY's "SCOPE BOUNDARY" comment
    //     for why those two dimensions are deliberately not enumerated) must return `false` here.
    //     This group's classes are NOT legitimate/safe like group 2 — they really do suppress the
    //     outline in a real Tailwind build; documenting that the detector currently misses them is
    //     itself the point, not a claim they're fine to use.
    const bad = [
      "outline-none",
      "focus:outline-none",
      "focus-visible:outline-none",
      "!outline-none",
      "[outline:none]",
      "[outline:0]",
      // Round 3 additions: Sol confirmed via a real Tailwind compile that these also suppress
      // the outline, and the prior regex missed all five.
      "focus:!outline-none",
      "outline-none!",
      "focus:outline-none!",
      "[&:focus]:outline-none",
      "data-[state=open]:outline-none",
      // Round 4 additions: named group/peer modifiers using `/`.
      "group-focus/item:outline-none",
      "peer-focus/field:outline-none",
      // Round 5 additions: nested-bracket selectors — the class of syntax that finally forced
      // abandoning variant-chain parsing altogether in favor of terminal-segment matching.
      "[&[data-active]]:outline-none",
      "[&_[data-state=open]]:outline-none",
      "group-[&[data-active]]:outline-none",
      // Round 6 additions: new terminal-utility spellings (not variant syntax) that
      // TERMINAL_UTILITY's Round-5 form was still missing — only outline-hidden is a named
      // utility here, the rest are arbitrary-value/property forms — each verified by real
      // Tailwind 4.3.3 compile, including the zero-value spellings the coordinator asked to check.
      "outline-hidden",
      "outline-0",
      "focus:outline-0",
      "outline-[0]",
      "outline-[0px]",
      "[outline-style:none]",
      "[outline-width:0]",
      "[outline-width:0px]",
      "[outline:0px]",
    ];
    for (const className of bad) expect(suppressesOutline(className)).toBe(true);

    const legitimate = [
      "outline-solid",
      "outline-ring",
      "outline-offset-2",
      "outline-[length:var(--border-width-bold)]",
      // Round 6: looks like a suppressing form but was verified NOT to be one — it compiles to
      // the invalid, no-op declaration `outline-color: none`, not an outline-style/width zero.
      "outline-[none]",
    ];
    for (const className of legitimate) expect(suppressesOutline(className)).toBe(false);

    // Round 7: Sol compiled these against real Tailwind 4.3.3 and confirmed every one of them
    // DOES suppress the outline in an actual build — they are not safe/legitimate classes, they
    // are real bugs-in-waiting that this detector's bounded vocabulary deliberately does not try
    // to catch (see TERMINAL_UTILITY's "SCOPE BOUNDARY" comment for why: CSS zero-length and
    // transparent color are both open-ended, unenumerable spelling spaces, unlike Tailwind's fixed
    // utility-name vocabulary). This group exists to make that gap explicit and machine-checked —
    // if a future round of work narrows the gap (e.g. by teaching the detector to parse arbitrary
    // values' units), the corresponding line here should move up into `bad`, not be deleted.
    const realButOutOfScope = [
      // Zero-length outline-width spelled with a unit other than bare 0/0px.
      "outline-[0rem]",
      "outline-[length:0rem]",
      "[outline-width:0rem]",
      "[outline:0rem]",
      // Zero-length spelled via an arbitrary calc() expression.
      "outline-[calc(0px)]",
      // Transparent outline-color, in several of its infinitely many spellings.
      "outline-transparent",
      "outline-[transparent]",
      "[outline-color:transparent]",
      "outline-[#0000]",
    ];
    for (const className of realButOutOfScope) expect(suppressesOutline(className)).toBe(false);
  });

  it("keeps the combined editor draft and sends the dedicated versioned route", async () => {
    const host = await mount(emptySchedule);
    queryClient.setQueryData(projectDataKeys.detail(projectId), { id: projectId });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const publish = vi.spyOn(runtime, "publish");
    const set = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Set Deadline")!;
    await act(async () => { set.click(); await Promise.resolve(); });
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')!, "2027-01-15");
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="Deadline time"]')!, "09:00");
    const preset = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.parentElement?.textContent?.includes("1 day"))!;
    await act(async () => { preset.click(); await Promise.resolve(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await Promise.resolve(); });
    await flush();
    expect(apiPutMock).toHaveBeenCalledWith(`/api/projects/${projectId}/deadline`, { expectedVersion: 0, deadline: { localCivil: "2027-01-15T09:00" }, reminderOffsetsMinutes: [1440] });
    expect(invalidate.mock.calls.filter(([options]) => JSON.stringify(options?.queryKey) === JSON.stringify(projectDataKeys.detail(projectId)))).toHaveLength(1);
    expect(invalidate.mock.calls.some(([options]) => options?.queryKey?.[0] === "dashboard-projects")).toBe(false);
    expect(invalidate.mock.calls.some(([options]) => options?.queryKey?.[0] === "production-calendar")).toBe(false);
    expect(publish.mock.calls.map(([message]) => message.type)).toEqual(expect.arrayContaining(["project-data-invalidated", "dashboard-board-invalidated", "production-calendar-invalidated"]));
    expect(publish.mock.calls.find(([message]) => message.type === "project-data-invalidated")?.[0]).toMatchObject({ projectId, resources: [{ kind: "detail" }, { kind: "activity" }] });
    expect(host.textContent).toContain("2027-01-15 09:00");
  });

  it("keeps the exact draft and exposes reapply controls on a version conflict", async () => {
    apiPutMock.mockRejectedValueOnce(new ApiError("Project deadline changed; reload before saving.", 409, { current: { ...activeSchedule, version: 2 } }));
    const host = await mount(emptySchedule);
    await act(async () => { host.querySelector<HTMLButtonElement>("button")!.click(); await Promise.resolve(); });
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')!, "2027-01-15");
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="Deadline time"]')!, "09:00");
    await act(async () => { host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await Promise.resolve(); });
    await flush();
    expect(host.textContent).toContain("Deadline changed elsewhere.");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')?.value).toBe("2027-01-15");
    expect(host.textContent).toContain("Reload latest");
    expect(host.textContent).toContain("Review and reapply my draft");
  });

  it("retains an exact draft through Reload latest and resubmits it against the new version", async () => {
    apiPutMock
      .mockRejectedValueOnce(new ApiError("That Sydney time occurs twice. Choose Earlier or Later.", 400, {
        code: "deadline_repeated_local_time",
        choices: [{ disambiguation: "earlier", utcOffsetMinutes: 660 }, { disambiguation: "later", utcOffsetMinutes: 600 }],
      }))
      .mockRejectedValueOnce(new ApiError("Project deadline changed; reload before saving.", 409, { current: authorityAfterConflict }))
      .mockResolvedValueOnce({ changed: true, current: savedDraftSchedule, eventIntent: null, publicationIds: [] });
    const host = await mount(emptySchedule);
    await act(async () => { host.querySelector<HTMLButtonElement>("button")!.click(); await Promise.resolve(); });
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')!, "2026-04-05");
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="Deadline time"]')!, "02:30");
    await act(async () => { host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); await Promise.resolve(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await Promise.resolve(); });
    await flush();
    await act(async () => { host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.click(); await Promise.resolve(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await Promise.resolve(); });
    await flush();
    expect(host.textContent).toContain("Deadline changed elsewhere.");
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Reload latest")!.click(); await Promise.resolve(); });
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')?.value).toBe("2027-02-20");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Deadline time"]')?.value).toBe("10:00");
    expect(host.textContent).toContain("Review and reapply my draft");
    expect(host.textContent).toContain("Authoritative: 2027-02-20 10:00 · 4 hours");
    expect(host.textContent).toContain("Saved draft: 2026-04-05 02:30 (later) · 1 day");
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Review and reapply my draft")!.click(); await Promise.resolve(); });
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')?.value).toBe("2026-04-05");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Deadline time"]')?.value).toBe("02:30");
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    await act(async () => { host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await Promise.resolve(); });
    await flush();
    expect(apiPutMock).toHaveBeenLastCalledWith(`/api/projects/${projectId}/deadline`, { expectedVersion: 2, deadline: { localCivil: "2026-04-05T02:30", disambiguation: "later" }, reminderOffsetsMinutes: [1440] });
  });

  it("keeps a dirty, unsaved draft through a background schedule refresh unrelated to any save attempt", async () => {
    const host = await mount(emptySchedule);
    await act(async () => { host.querySelector<HTMLButtonElement>("button")!.click(); await Promise.resolve(); });
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')!, "2027-01-15");
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="Deadline time"]')!, "09:00");

    // Simulate the parent re-rendering with a fresh server-authoritative schedule from an
    // ordinary background invalidation/refetch — not a save conflict, not a user action.
    await rerenderSchedule(activeSchedule);

    expect(host.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')?.value).toBe("2027-01-15");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Deadline time"]')?.value).toBe("09:00");
    expect(apiPutMock).not.toHaveBeenCalled();
  });

  it.each([
    ["scheduled", { ...summarySchedule, state: "scheduled" as const }, true],
    ["overdue", { ...summarySchedule, state: "overdue" as const }, true],
    ["delivered", { ...summarySchedule, state: "inactive_delivered" as const }, false],
    ["archived", { ...summarySchedule, state: "inactive_archived" as const }, false],
  ])("shows every configured and skipped reminder offset for the %s rail state", async (_name, schedule, canWrite) => {
    const host = await mount(schedule, canWrite);
    expect(host.textContent).toContain("Configured advance reminders: 1 day, 4 hours, 1 hour");
    expect(host.textContent).toContain("Skipped elapsed advances: 1 day, 4 hours");
    if (_name === "overdue") expect(host.textContent).toContain("Overdue");
  });

  it("shows the complete reminder summary to a read-only viewer", async () => {
    const host = await mount(summarySchedule, false);
    expect(host.textContent).toContain("Configured advance reminders: 1 day, 4 hours, 1 hour");
    expect(host.textContent).toContain("Skipped elapsed advances: 1 day, 4 hours");
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });

  it("keeps a repeated Sydney time draft until an explicit fold is chosen", async () => {
    apiPutMock.mockRejectedValueOnce(new ApiError("That Sydney time occurs twice. Choose Earlier or Later.", 400, {
      code: "deadline_repeated_local_time",
      choices: [{ disambiguation: "earlier", utcOffsetMinutes: 660 }, { disambiguation: "later", utcOffsetMinutes: 600 }],
    }));
    const host = await mount(emptySchedule);
    await act(async () => { host.querySelector<HTMLButtonElement>("button")!.click(); await Promise.resolve(); });
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')!, "2026-04-05");
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="Deadline time"]')!, "02:30");
    await act(async () => { host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await Promise.resolve(); });
    await flush();
    expect(host.textContent).toContain("Earlier (+660 minutes)");
    expect(host.textContent).toContain("Later (+600 minutes)");
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await act(async () => { host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.click(); await Promise.resolve(); });
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  });

  it("keeps the date and time draft attached when Sydney rejects a DST gap", async () => {
    apiPutMock.mockRejectedValueOnce(new ApiError("That Sydney time does not exist because the clocks move forward.", 400, { code: "deadline_nonexistent_local_time" }));
    const host = await mount(emptySchedule);
    await act(async () => { host.querySelector<HTMLButtonElement>("button")!.click(); await Promise.resolve(); });
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')!, "2026-10-04");
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="Deadline time"]')!, "02:30");
    await act(async () => { host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await Promise.resolve(); });
    await flush();
    expect(host.textContent).toContain("That Sydney time does not exist");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')?.value).toBe("2026-10-04");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Deadline time"]')?.value).toBe("02:30");
  });
});
