import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/reui/button";
import { pushToast } from "../../lib/toast-store";

const COPIED_MS = 2000;

/**
 * Copies a string the caller already holds (#741 11b: a Review link's one-time URL). The clipboard core of `quincy/CopyProjectLinkButton`
 * (the same `c-button-41` Copy -> Copied swap on the installed `reui/button`, the same refusal to use the registry's
 * `use-copy-to-clipboard`, which swallows a rejected write and throws where `navigator.clipboard` is missing). Never copies on its own:
 * a clipboard write after an awaited fetch loses the user activation in Safari, so the person presses it.
 * Sits in `components/video/` for this slice only; folding `CopyProjectLinkButton` onto it is a follow-up in a quincy-layer PR.
 */
export function CopyTextButton({ text, label = "Copy link", success = "Link copied.", failure = "Couldn't copy the link.", className }: { text: string; label?: string; success?: string; failure?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  function copy() {
    if (!navigator.clipboard?.writeText) { pushToast(failure, "error"); return; }
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        pushToast(success);
        window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setCopied(false), COPIED_MS);
      },
      () => pushToast(failure, "error"),
    );
  }

  return (
    <Button type="button" variant="outline" data-testid="copy-text" className={className} onClick={copy}>
      {copied ? <CheckIcon className="size-3.5" aria-hidden="true" data-icon="inline-start" /> : <CopyIcon className="size-3.5" aria-hidden="true" data-icon="inline-start" />}
      {copied ? "Copied" : label}
    </Button>
  );
}
