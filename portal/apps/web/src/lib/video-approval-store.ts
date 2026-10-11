import { classifyVideoApprovalError, videoApprovalErrorText } from "./video-approval-errors";

/**
 * What the staff Decisions + Release panel keeps for a Project tab (#741 14-ui-staff): one store per person and Project, created by the Video collection beside the note forms and
 * retired with them, so a write's lifetime and an unsent note or payment reference are the tab's and not any component's (docs/lessons.md "Form lifetime is not component lifetime").
 * A slot per Version holds that Version's one write in flight (a client decision, a Release, a Withdraw) and its unsent decision note; a slot per Video holds the premium and
 * unlock writes and the unsent payment reference. A completion applies only to the operation that started it and only while the store is alive. Imports only the error classifier.
 */
export type ApprovalOpKind = "decision" | "release" | "withdraw" | "premium" | "unlock" | "relock";
export type ApprovalSlot = { op: { id: number; kind: ApprovalOpKind } | null; /** What the last refused write says; cleared by the next write that succeeds or starts. */ problem: string | null; note: string; paymentRef: string };
export type ApprovalRunResult = "ok" | "failed" | "busy" | "dropped";

export const versionSlot = (assetId: string): string => `version:${assetId}`;
export const videoSlot = (videoId: string): string => `video:${videoId}`;

const EMPTY: ApprovalSlot = Object.freeze({ op: null, problem: null, note: "", paymentRef: "" });

export function createVideoApprovalStore(key: string) {
  const slots = new Map<string, ApprovalSlot>();
  const listeners = new Set<() => void>();
  let dead = false;
  let seq = 0;
  const get = (slot: string): ApprovalSlot => slots.get(slot) ?? EMPTY;
  const write = (slot: string, next: Partial<ApprovalSlot>) => {
    if (dead) return;
    const current = get(slot);
    const merged = { ...current, ...next };
    if ((Object.keys(merged) as Array<keyof ApprovalSlot>).every((k) => merged[k] === current[k])) return;
    slots.set(slot, Object.freeze(merged));
    for (const listener of [...listeners]) listener();
  };

  return {
    key,
    getSlot: get,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setNote(slot: string, note: string) { write(slot, { note }); },
    setPaymentRef(slot: string, paymentRef: string) { write(slot, { paymentRef }); },
    clearProblem(slot: string) { write(slot, { problem: null }); },
    /**
     * Sends one write for `slot`. A slot with a write in flight refuses (`busy`) rather than queueing: the person decides again after reading the answer. The completion applies
     * only while its operation still owns the slot (`dropped` once the store is retired), clears the draft that write carried only if it was not edited meanwhile, and turns a refusal
     * into the sentence the panel shows.
     */
    async run(slot: string, kind: ApprovalOpKind, send: () => Promise<unknown>): Promise<ApprovalRunResult> {
      if (dead) return "dropped";
      if (get(slot).op) return "busy";
      const id = ++seq;
      const started = get(slot);
      write(slot, { op: { id, kind }, problem: null });
      try {
        await send();
      } catch (error) {
        if (dead || get(slot).op?.id !== id) return "dropped";
        write(slot, { op: null, problem: videoApprovalErrorText(classifyVideoApprovalError(error)) });
        return "failed";
      }
      if (dead || get(slot).op?.id !== id) return "dropped";
      const now = get(slot);
      write(slot, {
        op: null, problem: null,
        ...(kind === "decision" && now.note === started.note ? { note: "" } : {}),
        ...(kind === "unlock" && now.paymentRef === started.paymentRef ? { paymentRef: "" } : {}),
      });
      return "ok";
    },
    retire() { dead = true; slots.clear(); listeners.clear(); },
  };
}
export type VideoApprovalStore = ReturnType<typeof createVideoApprovalStore>;
