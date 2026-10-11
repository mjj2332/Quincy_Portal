import type { WriteResult } from "./guest-api";

/** A write that was not sent because one for the same key is still out, or whose answer arrived after the screen or Version it was made in had gone. Neither changes anything. */
export type Skipped<R extends { kind: string } = WriteResult> = { kind: "busy" } | { kind: "stale"; /** What the write came to, which the caller may need even though the answer does not apply to the screen now on show (a reply that was saved must clear its draft). */ result: R };
/** `R` is any answer with a `kind` whose refusals that change the page (`unverified`, `gone`, `archived`) mean the same for every write: a note write (`WriteResult`), a decision or a paste (`PasteResult`). `owns`, when given, says whether the caller still owns the answer once it arrives. */
export type Run = <R extends { kind: string }>(key: string, call: () => Promise<R>, owns?: () => boolean) => Promise<R | Skipped<R>>;

/** What the screen on show tells the writer: the Version it is on, what a refusal that changes the page does, and what to do when a write started on an earlier screen settles. All three are read live. */
export type WriterBinding = {
  scope: string;
  effects: { onUnverified: () => void; onGone: () => void; onArchived: () => void };
  /** A write started on a screen that has since gone (the guest went to All videos and back) has settled: the list on this screen may be missing its answer, so read it again. */
  onLostSettle: () => void;
};

export type GuestWriter = {
  run: Run;
  /** Like `run`, for a write that applies to the whole link (the email-updates switch), not to one Version: the screen on show handles a page-level refusal whichever Version or screen the write started on. Only with no screen on show is the answer `stale`. */
  runLink: Run;
  epoch: () => number;
  attach: (binding: WriterBinding) => void;
  detach: (binding: WriterBinding) => void;
};

/**
 * Serialises a guest's writes (#741 13c): note writes, decisions, pastes and the email-updates subscription write. It is created by `GuestApp` and lives as long as the link's session does, not as long as the video screen: pending-write ownership that died
 * with the screen let a guest go to All videos and back during a slow Post and send the same note again (see docs/lessons.md, "Form lifetime is not component lifetime").
 *
 * One write per key is in flight at a time (a second for the same key answers `busy` without sending). An answer is checked against the screen binding and `scope` (the Version on screen) it
 * started in: after the guest moved on it is `stale` and the caller applies nothing; if a screen is on show by then it is told (`onLostSettle`) so it can read the list again. `epoch()` moves
 * whenever a write starts or settles, so a list read can tell it overlapped a write and must not overwrite the answer the write already applied. `effects` run for the refusals that change the
 * page (verification lost, the link gone, the Project archived) and only for a write that is not stale.
 */
export function createGuestWriter(): GuestWriter {
  const inflight = new Set<string>();
  let epoch = 0;
  let bound: WriterBinding | null = null;

  const start = (linkScoped: boolean): Run => async <R extends { kind: string }>(key: string, call: () => Promise<R>, owns?: () => boolean): Promise<R | Skipped<R>> => {
    if (inflight.has(key)) return { kind: "busy" };
    inflight.add(key);
    epoch += 1;
    const startedBinding = bound;
    const startedScope = bound?.scope ?? null;
    let result: R;
    try { result = await call(); } finally { inflight.delete(key); epoch += 1; }
    // A caller whose question was replaced while this one was out (a preview for a source no longer chosen) owns nothing: its refusal must not reach the page.
    if (owns !== undefined && !owns()) return { kind: "stale", result };
    if (bound === null) return { kind: "stale", result };
    if (!linkScoped && (bound !== startedBinding || bound.scope !== startedScope)) {
      if (bound !== startedBinding) bound.onLostSettle();
      return { kind: "stale", result };
    }
    if (result.kind === "unverified") bound.effects.onUnverified();
    else if (result.kind === "gone") bound.effects.onGone();
    else if (result.kind === "archived") bound.effects.onArchived();
    return result;
  };
  return {
    run: start(false),
    runLink: start(true),
    epoch: () => epoch,
    attach: (binding) => { bound = binding; },
    detach: (binding) => { if (bound === binding) bound = null; },
  };
}
