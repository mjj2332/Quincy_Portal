import type { Reveal } from "../../lib/review-link-form-store";
import { Button } from "../quincy/Button";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../reui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../reui/input-group";
import { DIALOG_TITLE, ReviewLinkDialogFrame } from "./ReviewLinkDialogFrame";
import { CopyTextButton } from "./CopyTextButton";

/**
 * The one-time reveal step (#741 11b): the link's URL in a read-only input group with a Copy button. `c-input-group-40` (its visibility
 * dropdown dropped) on the installed `reui/input-group`. There is no auto-copy: a clipboard write after an awaited fetch loses the user
 * activation in Safari. The URL is held by the form store in memory only and is gone once this step is dismissed.
 */
export function ReviewLinkReveal({ reveal, queued = 1, onDone }: { reveal: Reveal; /** How many one-time URLs are waiting, this one included. */ queued?: number; onDone: () => void }) {
  return <div data-testid="review-link-reveal" className="contents"><ReviewLinkDialogFrame
    header={<DialogHeader>
      <DialogTitle className={DIALOG_TITLE}>Review link ready</DialogTitle>
      <DialogDescription>{`${reveal.origin === "replace" ? "This replaces the old link. " : ""}This is the only time the full link is shown. Lost it? Use Replace link.`}</DialogDescription>
      <p className="[font:var(--weight-medium)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]">{`${reveal.label ?? "Untitled link"}${queued > 1 ? ` · 1 of ${queued}` : ""}`}</p>
    </DialogHeader>}
    footer={<DialogFooter>
      <Button type="button" variant="primary" className="min-h-11" onClick={onDone}>Done</Button>
    </DialogFooter>}
  >
    <InputGroup className="max-[721px]:flex-wrap">
      <InputGroupInput readOnly aria-label="Review link URL" value={reveal.url} autoComplete="off" spellCheck={false} onFocus={(event) => event.currentTarget.select()} className="min-w-0 [font-family:var(--font-mono)] max-[721px]:basis-full" />
      <InputGroupAddon align="inline-end" className="max-[721px]:basis-full max-[721px]:justify-end">
        <CopyTextButton text={reveal.url} className="min-h-11" />
      </InputGroupAddon>
    </InputGroup>
  </ReviewLinkDialogFrame></div>;
}
