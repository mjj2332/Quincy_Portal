import { Button } from "../components/reui/button";

const defaultReload = () => window.location.reload();

/**
 * Shown when the guest chunk cannot load (#741 12b, lessons "A stale lazy chunk after a deploy"): a deploy replaced the hashed file or the download failed. The browser caches the rejected
 * import, so only a full reload recovers, and that reload is the visitor's to press. Self-contained: no staff module, no request.
 */
export function GuestLoadFailure({ reload = defaultReload }: { reload?: () => void }) {
  return <div role="alert" data-testid="guest-load-failure" data-surface="inverse" className="flex min-h-dvh flex-col items-center justify-center gap-[var(--space-4)] bg-background p-[var(--space-5)] text-center text-foreground">
    <p className="m-0 max-w-[40ch] [font:var(--type-body)]">This page could not load. It may have been updated. Reload to try again.</p>
    <Button type="button" variant="secondary" onClick={() => { reload(); }}>Reload</Button>
  </div>;
}
