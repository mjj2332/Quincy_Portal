import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { staffPathFor, type WorkspaceTab } from "@quincy/shared";
import { Button } from "@/components/reui/button";
import { pushToast } from "../../lib/toast-store";

const COPIED_MS = 2000;

/**
 * #367 — copies the link to the Workspace tab being SHOWN. Composition of ReUI `c-button-41` (icon
 * and label swap Copy -> Copied) on the installed `reui/button`. The registry's
 * `use-copy-to-clipboard` hook is not used: it swallows a rejected write with `console.error` and
 * throws where `navigator.clipboard` is undefined, and this control needs a visible failure path.
 * The link is built from the `tab` prop, not `window.location`, so it is right even before the
 * URL's own `replace` has landed. The outcome is announced through the shared toast live region.
 */
export function CopyProjectLinkButton({ projectId, tab }: { projectId: string; tab: WorkspaceTab }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  function copy() {
    const href = new URL(staffPathFor({ kind: "project", projectId, arrivalTab: tab }), window.location.origin).href;
    if (!navigator.clipboard?.writeText) { pushToast("Couldn't copy the link.", "error"); return; }
    navigator.clipboard.writeText(href).then(
      () => {
        setCopied(true);
        pushToast("Link copied.");
        window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setCopied(false), COPIED_MS);
      },
      () => pushToast("Couldn't copy the link.", "error"),
    );
  }

  return (
    <Button type="button" variant="ghost" data-testid="copy-project-link" onClick={copy}>
      {copied ? <CheckIcon aria-hidden="true" data-icon="inline-start" /> : <CopyIcon aria-hidden="true" data-icon="inline-start" />}
      {copied ? "Copied" : "Copy link"}
    </Button>
  );
}
