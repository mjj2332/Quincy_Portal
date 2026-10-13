import { useCallback, useRef, useState, type FormEvent } from "react";
import type { Role } from "@quincy/shared";
import { useOptionalProjectQueryClient } from "../../lib/project-data";
import { pushToast } from "../../lib/toast-store";
import { classifyRenameError, renameErrorText, renameVideoVersion, type ClassifiedRenameError } from "../../lib/video-rename-data";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../reui/dialog";
import { Button } from "../quincy/Button";
import { Notice } from "../quincy/Notice";
import { QuincyField } from "../quincy/QuincyField";
import { DIALOG_TITLE } from "./ReviewLinkDialogFrame";

/** The Version a rename is aimed at: frozen when the dialog opens, so an upload that lands while it is open is refused by the server rather than renamed by mistake. */
export type RenameTarget = { assetId: string; originalFilename: string };

const EXTENSION = /\.(mp4|mov)$/i;
const stemLength = (name: string) => name.replace(EXTENSION, "").length;

/**
 * Rename a Video from its card (#867): the full file name of the latest Version, stem selected, Enter to save. The film's title follows the name until the next upload replaces it. A refusal keeps the
 * dialog and the typed text; when a newer Version won the race the person is offered, never forced, to apply the same name to the latest one. Mounted beside the card, not inside it, so nothing typed here
 * reaches the card's select and open handlers.
 * Ledger: `reui/dialog` (shell), `quincy/QuincyField` (reui field + input), `quincy/Button`, `quincy/Notice`; behaviour from FreeFrame's name-dialog.
 */
export function VideoRenameDialog({ open, onOpenChange, projectId, role, target, latest, finalFocus }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  role: Role;
  target: RenameTarget;
  /** The card's current latest Version, read when the person asks to apply the name to it. */
  latest: RenameTarget;
  finalFocus: () => HTMLElement | null;
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent data-testid="video-rename-dialog" showCloseButton={false} finalFocus={() => finalFocus() ?? true} className="flex flex-col gap-[var(--space-4)] sm:max-w-[420px]">
      <RenameForm projectId={projectId} role={role} target={target} latest={latest} onClose={() => onOpenChange(false)} />
    </DialogContent>
  </Dialog>;
}

/** Mounted with the dialog's content, so every opening starts from the target's name with nothing left over from the last. */
function RenameForm({ projectId, role, target, latest, onClose }: { projectId: string; role: Role; target: RenameTarget; latest: RenameTarget; onClose: () => void }) {
  const queryClient = useOptionalProjectQueryClient();
  const [aimedAt, setAimedAt] = useState(target);
  const [value, setValue] = useState(target.originalFilename);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ClassifiedRenameError | null>(null);
  const inFlight = useRef(false);
  // Focus and select the stem once, when the field mounts: a ref that changed identity would reselect on every keystroke.
  const initial = target.originalFilename;
  const focusStem = useCallback((el: HTMLInputElement | null) => { if (el) { el.focus(); el.setSelectionRange(0, stemLength(initial)); } }, [initial]);

  const trimmed = value.trim();
  const canSave = !pending && problem?.kind !== "not_latest" && trimmed !== "" && stemLength(trimmed) > 0 && trimmed !== aimedAt.originalFilename;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave || !queryClient || inFlight.current) return;
    inFlight.current = true; setPending(true); setProblem(null);
    try {
      await renameVideoVersion({ queryClient, projectId, role }, { assetId: aimedAt.assetId, filename: trimmed });
      pushToast("File renamed.");
      onClose();
    } catch (error) {
      setProblem(classifyRenameError(error));
    } finally { inFlight.current = false; setPending(false); }
  };

  return <form onSubmit={(event) => void submit(event)} className="grid gap-[var(--space-4)]" noValidate>
    <DialogHeader>
      <DialogTitle className={DIALOG_TITLE}>Rename file</DialogTitle>
      <DialogDescription className="text-foreground-secondary">The film's title follows this file name until the next version is uploaded.</DialogDescription>
    </DialogHeader>
    <QuincyField id="video-rename-filename" label="File name" ref={focusStem} value={value} onChange={(event) => { setValue(event.target.value); if (problem && problem.kind !== "not_latest") setProblem(null); }} autoComplete="off" spellCheck={false} />
    {problem && <Notice tone="critical" role="alert" data-testid="video-rename-error">
      <p>{renameErrorText(problem)}</p>
      {problem.kind === "not_latest" && <Button type="button" variant="secondary" className="mt-[var(--space-2)] min-h-[44px]" onClick={() => { setAimedAt(latest); setProblem(null); }}>Apply to the latest version</Button>}
    </Notice>}
    <DialogFooter>
      <Button type="button" variant="secondary" className="min-h-[44px]" onClick={onClose}>Cancel</Button>
      <Button type="submit" variant="primary" className="min-h-[44px]" disabled={!canSave}>{pending ? "Saving…" : "Save"}</Button>
    </DialogFooter>
  </form>;
}
