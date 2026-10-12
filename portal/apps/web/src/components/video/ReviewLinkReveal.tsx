import type { Reveal } from "../../lib/review-link-form-store";
import { Button } from "../quincy/Button";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../reui/dialog";
import { DIALOG_TITLE, ReviewLinkDialogFrame } from "./ReviewLinkDialogFrame";
import { ReviewLinkUrlField } from "./ReviewLinkUrlField";

/**
 * The reveal step after Create or Replace (#741 11b): the link's URL in `ReviewLinkUrlField`. The URL is held by the form store in memory only and is gone once
 * this step is dismissed. Since #815 staff can copy it again from the link's settings, so this step is a convenience, not the only chance.
 */
export function ReviewLinkReveal({ reveal, queued = 1, onDone }: { reveal: Reveal; /** How many reveals are waiting, this one included. */ queued?: number; onDone: () => void }) {
  return <div data-testid="review-link-reveal" className="contents"><ReviewLinkDialogFrame
    header={<DialogHeader>
      <DialogTitle className={DIALOG_TITLE}>Review link ready</DialogTitle>
      <DialogDescription className="text-foreground-secondary">{`${reveal.origin === "replace" ? "This replaces the old link. " : ""}You can copy this link again from its settings.`}</DialogDescription>
      <p className="[font:var(--weight-medium)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]">{`${reveal.label ?? "Untitled link"}${queued > 1 ? ` · 1 of ${queued}` : ""}`}</p>
    </DialogHeader>}
    footer={<DialogFooter>
      <Button type="button" variant="primary" className="min-h-11" onClick={onDone}>Done</Button>
    </DialogFooter>}
  >
    <ReviewLinkUrlField url={reveal.url} />
  </ReviewLinkDialogFrame></div>;
}
