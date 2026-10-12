import { useEffect, useRef, useState } from "react";
import { Share2Icon } from "lucide-react";
import { Button } from "../components/reui/button";
import { TOUCH } from "./UnlockControl";

const COPIED_MS = 3000;
type Status = "idle" | "copied" | "copy-failed" | "share-failed";
const MESSAGE: Record<Status, string> = { idle: "", copied: "Link copied.", "copy-failed": "Couldn't copy the link. Copy it from the address bar.", "share-failed": "Couldn't share." };

/**
 * The hero's Share (#837): the page's own public address and nothing else (no new link, token or tracking). The native share sheet is called straight from the click, where a browser requires it; where there is none the address
 * is copied and the person is told. Cancelling the sheet is not a failure. A failed share offers an explicit Copy link; a clipboard that is absent or refuses says so rather than claiming success. The guest page reaches no staff toast or clipboard flow (`guest-boundary.guard.test.ts`).
 */
export function DeliveryShareButton({ url, title }: { url: string; title: string }) {
  const [status, setStatus] = useState<Status>("idle");
  const pending = useRef(false);
  const alive = useRef(true);
  const shareRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => { alive.current = true; return () => { alive.current = false; window.clearTimeout(timer.current); }; }, []);
  const settle = (next: Status) => {
    if (!alive.current) return;
    setStatus(next);
    window.clearTimeout(timer.current);
    // The "Link copied." confirmation is transient; failures stay until the next attempt.
    if (next === "copied") timer.current = window.setTimeout(() => { setStatus("idle"); }, COPIED_MS);
  };
  const copy = async () => {
    try {
      if (typeof navigator.clipboard?.writeText !== "function") throw new Error("no clipboard");
      await navigator.clipboard.writeText(url);
      settle("copied");
    } catch { settle("copy-failed"); }
  };
  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    try { await action(); } finally { pending.current = false; }
  };
  const share = () => run(async () => {
    if (typeof navigator.share !== "function") { await copy(); return; }
    try { await navigator.share({ title, url }); settle("idle"); }
    catch (error) { settle(error instanceof DOMException && error.name === "AbortError" ? "idle" : "share-failed"); }
  });
  return <>
    <Button ref={shareRef} type="button" variant="outline" size="lg" data-testid="delivery-share" className={TOUCH} onClick={() => { void share(); }}><Share2Icon aria-hidden />Share</Button>
    {status === "share-failed" && <Button type="button" variant="ghost" size="lg" data-testid="delivery-share-copy" className={TOUCH} onClick={() => { void run(copy).then(() => { shareRef.current?.focus(); }); }}>Copy link</Button>}
    <span data-testid="delivery-share-status" role="status" className="self-center [font:var(--type-body-sm)] text-on-inverse-muted">{MESSAGE[status]}</span>
  </>;
}
