import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/reui/button";
import { pushToast } from "../../lib/toast-store";
import { Tooltip, TooltipContent, TooltipTrigger } from "../reui/tooltip";

const COPIED_MS = 2000;

/**
 * Copies a string the caller already holds (#741 11b, #815: a Review link's URL). The clipboard core of `quincy/CopyProjectLinkButton`
 * (the same `c-button-41` Copy -> Copied swap on the installed `reui/button`, the same refusal to use the registry's
 * `use-copy-to-clipboard`, which swallows a rejected write and throws where `navigator.clipboard` is missing). Never copies on its own:
 * a clipboard write after an awaited fetch loses the user activation in Safari, so the person presses it.
 * Sits in `components/video/` for this slice only; folding `CopyProjectLinkButton` onto it is a follow-up in a quincy-layer PR.
 */
export function CopyTextButton({ text, label = "Copy link", success = "Link copied.", failure = "Couldn't copy the link.", className, ariaLabel, labelClassName, tooltip = false }: { text: string; label?: string; success?: string; failure?: string; className?: string; /** Overrides the accessible name where the visible label alone is ambiguous, such as one Copy per row. */ ariaLabel?: string; /** Classes on the label text: the top bar makes it `sr-only` when it is narrow. */ labelClassName?: string; /** Name the action in a tooltip (for a label that is not always drawn). */ tooltip?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  const textRef = useRef(text);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  // A new `text` (the reveal moving on to the next queued URL) must not inherit the last URL's "Copied", and a write that was
  // started for the old text must not mark the new one copied when it resolves late.
  useEffect(() => {
    textRef.current = text;
    window.clearTimeout(timerRef.current);
    setCopied(false);
  }, [text]);

  function copy() {
    if (!navigator.clipboard?.writeText) { pushToast(failure, "error"); return; }
    const written = text;
    navigator.clipboard.writeText(written).then(
      () => {
        if (textRef.current !== written) return;
        setCopied(true);
        pushToast(success);
        window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setCopied(false), COPIED_MS);
      },
      () => pushToast(failure, "error"),
    );
  }

  const button = (
    <Button type="button" variant="outline" data-testid="copy-text" className={className} onClick={copy} {...(ariaLabel ? { "aria-label": ariaLabel } : {})}>
      {copied ? <CheckIcon className="size-3.5" aria-hidden="true" data-icon="inline-start" /> : <CopyIcon className="size-3.5" aria-hidden="true" data-icon="inline-start" />}
      {labelClassName ? <span className={labelClassName}>{copied ? "Copied" : label}</span> : (copied ? "Copied" : label)}
    </Button>
  );
  if (!tooltip) return button;
  return <Tooltip><TooltipTrigger render={button} /><TooltipContent>{label}</TooltipContent></Tooltip>;
}
