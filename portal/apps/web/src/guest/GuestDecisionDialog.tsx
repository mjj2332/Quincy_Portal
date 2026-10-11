import { useEffect, useRef, useState } from "react";
import { GUEST_DECISION_NOTE_MAX, type GuestDecisionInput } from "@quincy/shared";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../components/reui/alert-dialog";
import { Field, FieldLabel } from "../components/reui/field";
import { Textarea } from "../components/reui/textarea";
import { useNoteDraft, type GuestDrafts } from "./guest-drafts";

const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";
const PROBLEM = "m-0 text-destructive [font:var(--type-body-sm)]";

export type DecisionValue = GuestDecisionInput["decision"];
/** What a confirmed decision came to. `message` is what to tell the guest, or null when the answer is not for this dialog any more (the guest moved to another Version). */
export type DecisionOutcome = { ok: true } | { ok: false; message: string | null };

/** The draft-store key of the optional note: per Version and per decision, so a note typed for one is never sent with the other. */
export const decisionDraftKey = (assetId: string, value: DecisionValue): string => `decision:${assetId}:${value}`;

const COPY: Record<DecisionValue, { title: string; confirm: string; describe: (film: string, version: number) => string }> = {
  approved: { title: "Approve this version?", confirm: "Approve", describe: (film, version) => `You're telling the studio you're happy with ${film}, version ${version}.` },
  changes_requested: { title: "Request changes?", confirm: "Request changes", describe: (film, version) => `You're asking the studio to change ${film}, version ${version}. A note helps them see what.` },
};

/**
 * The confirm step of Approve / Request changes (#741 14-ui-guest): an alert dialog with an optional note. The note lives in `drafts` (created by `GuestApp`), so closing the dialog, a
 * re-verification or leaving the screen keeps it (docs/lessons.md, "Form lifetime is not component lifetime"). The dialog can be dismissed while the write is out: the write is the writer's
 * (it outlives this component), and its answer is applied by `onConfirm` only to the Version it was sent for. A fresh instance per Version and decision (the caller keys it), so pending
 * state never carries to another Version; `opId` makes an answer that arrives after this instance was closed or replaced change nothing here.
 */
export function GuestDecisionDialog({ value, assetId, film, version, drafts, open, onClose, onConfirm }: {
  value: DecisionValue;
  assetId: string;
  film: string;
  version: number;
  drafts: GuestDrafts;
  open: boolean;
  onClose: () => void;
  onConfirm: (note: string | undefined) => Promise<DecisionOutcome>;
}) {
  const key = decisionDraftKey(assetId, value);
  const draft = useNoteDraft(drafts, key);
  const text = draft?.text ?? "";
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const opId = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Reopening (the same instance can be closed and shown again) starts without the last answer's words.
  useEffect(() => { if (open) { opId.current += 1; setPending(false); setProblem(null); } }, [open]);
  const copy = COPY[value];
  const confirm = async () => {
    if (pending) return;
    opId.current += 1;
    const mine = opId.current;
    setPending(true); setProblem(null);
    const note = text.trim();
    const outcome = await onConfirm(note === "" ? undefined : note);
    if (!alive.current || opId.current !== mine) return;
    setPending(false);
    if (!outcome.ok) setProblem(outcome.message);
  };
  return <AlertDialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <AlertDialogContent size="default" data-testid="guest-decision-dialog">
      <AlertDialogHeader>
        <AlertDialogTitle>{copy.title}</AlertDialogTitle>
        <AlertDialogDescription className="text-foreground-secondary">{copy.describe(film, version)}</AlertDialogDescription>
      </AlertDialogHeader>
      <Field>
        <FieldLabel htmlFor="guest-decision-note">Note for the studio (optional)</FieldLabel>
        <Textarea id="guest-decision-note" data-testid="guest-decision-note" maxLength={GUEST_DECISION_NOTE_MAX} value={text}
          onChange={(event) => { drafts.set(key, { noteId: null, text: event.target.value, baseText: "", baseRevision: null, ackRevision: null }); }} />
      </Field>
      {problem !== null && <p role="alert" data-testid="guest-decision-problem" className={PROBLEM}>{problem}</p>}
      <AlertDialogFooter>
        <AlertDialogCancel data-testid="guest-decision-cancel" className={TOUCH}>Cancel</AlertDialogCancel>
        <AlertDialogAction data-testid="guest-decision-confirm" className={TOUCH} disabled={pending} onClick={() => { void confirm(); }}>{copy.confirm}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
