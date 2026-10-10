import { useEffect, useRef, useState } from "react";
import { Button } from "../components/reui/button";
import { EmptyState } from "../components/quincy/EmptyState";
import { postUnsubscribe } from "./guest-api";
import { UnavailableScreen } from "./GuestScreens";

type Phase = "working" | "unsubscribed" | "subscribed" | "unavailable";

/**
 * The digest email's unsubscribe page (#741 15b, settled decision 11). The token arrives as a prop, already scrubbed from the address by `mountGuestUnsubscribe`, and is held in memory only. It
 * POSTs the unsubscribe once on load (one click from the email), then offers Resubscribe, which a link scanner's unsubscribe can be undone with, and after that an Unsubscribe to undo that.
 * An unknown token or any failure of the first POST is the same calm unavailable screen as the review page; a failed button press keeps the page where it was and says so inline.
 */
export function GuestUnsubscribe({ token }: { token: string | null }) {
  const [phase, setPhase] = useState<Phase>(token === null ? "unavailable" : "working");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    // StrictMode runs this twice in development: the ref keeps it to one request.
    if (token === null || started.current) return;
    started.current = true;
    void postUnsubscribe(token).then((result) => { setPhase(result.kind === "ok" ? (result.subscribed ? "subscribed" : "unsubscribed") : "unavailable"); });
  }, [token]);

  if (phase === "unavailable") return <UnavailableScreen />;
  if (phase === "working" || token === null) return <main aria-busy="true" className="flex min-h-dvh items-center justify-center bg-background p-[var(--space-4)]" />;

  const change = async (subscribed: boolean) => {
    setBusy(true); setFailed(false);
    const result = await postUnsubscribe(token, subscribed);
    setBusy(false);
    if (result.kind === "ok") setPhase(result.subscribed ? "subscribed" : "unsubscribed");
    else if (result.kind === "gone") setPhase("unavailable");
    else setFailed(true);
  };
  const subscribed = phase === "subscribed";
  return <main className="flex min-h-dvh items-center justify-center bg-background p-[var(--space-4)]">
    <EmptyState data-testid="guest-unsubscribe" title={subscribed ? "You'll get emails about this review again." : "You won't get emails about this review."}>
      <p className="m-0 mb-[var(--space-4)]">{subscribed ? "You can stop them again whenever you like." : "Changed your mind? You can turn them back on."}</p>
      <Button type="button" variant={subscribed ? "secondary" : "default"} disabled={busy} onClick={() => { void change(!subscribed); }}>{subscribed ? "Unsubscribe" : "Resubscribe"}</Button>
      {failed ? <p role="alert" className="m-0 mt-[var(--space-3)] text-destructive">That didn't go through. Try again.</p> : null}
    </EmptyState>
  </main>;
}
