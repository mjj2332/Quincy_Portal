import { useCallback, useEffect, useState } from "react";
import { ApiError, apiDelete, apiGet } from "../lib/api";
import { Eyebrow } from "@/components/quincy/Eyebrow";
import { Notice } from "@/components/quincy/Notice";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/reui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/reui/empty";
import { Frame, FramePanel } from "@/components/reui/frame";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/reui/item";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/reui/alert-dialog";

export type ConnectedApp = { id: string; clientName: string; redirectHost: string; scopes: string[]; createdAt: number; lastUsedAt: number | null; status: string };

// Same page frame and head as NotificationPreferences / Admin: `.page` is unlayered app.css, so the narrower measure is `!`-prefixed.
const PAGE = "page !max-w-[var(--container-md)]";
const HEAD = "flex flex-wrap items-end justify-between gap-[var(--space-6)] mb-[var(--space-6)]";
const H1 = "[font:var(--type-h1)] tracking-[var(--tracking-tight)] m-0";
const LEDE = "mt-[var(--space-3)] mb-0 max-w-[46ch] [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary";

const SCOPE_LABEL: Record<string, string> = { read: "Read", write: "Write", admin: "Admin" };
const formatDay = (ms: number) => new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeZone: "Australia/Sydney" }).format(new Date(ms));

export function ConnectedApps() {
  const [apps, setApps] = useState<ConnectedApp[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ConnectedApp | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    apiGet<ConnectedApp[]>("/api/connected-apps").then(setApps, (reason) => setLoadError(reason instanceof ApiError ? reason.message : "Connected apps could not be loaded."));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function revoke() {
    if (!revoking) return;
    setPending(true); setError(null);
    try {
      await apiDelete<unknown>(`/api/connected-apps/${encodeURIComponent(revoking.id)}`);
      setApps((current) => current?.filter((app) => app.id !== revoking.id) ?? null);
      setRevoking(null);
    } catch (reason) { setError(reason instanceof ApiError ? reason.message : "The app could not be disconnected."); setRevoking(null); }
    finally { setPending(false); }
  }

  return (
    <main className={PAGE}>
      <header className={HEAD}>
        <div>
          <Eyebrow className="block mb-[var(--space-3)]">Personal settings</Eyebrow>
          <h1 className={H1}>Connected apps</h1>
          <p className={LEDE}>AI apps you have allowed to act as you in the Portal. Each one sees only what you can see.</p>
        </div>
      </header>

      {loadError && <Notice role="alert" className="mb-[var(--space-4)]">{loadError}</Notice>}
      {error && <Notice role="alert" className="mb-[var(--space-4)]">{error}</Notice>}

      <Frame>
        <FramePanel>
          {apps === null && !loadError && <p role="status" className="m-0 text-foreground-secondary">Loading connected apps…</p>}
          {apps !== null && apps.length === 0 && (
            <Empty data-testid="connected-apps-empty">
              <EmptyHeader>
                <EmptyTitle>No connected apps</EmptyTitle>
                <EmptyDescription>When you allow an AI app to connect to the Portal, it appears here and you can disconnect it at any time.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {apps !== null && apps.length > 0 && (
            <ItemGroup>
              {apps.map((app) => (
                <Item key={app.id} variant="outline" className="rounded-[var(--radius-card)]" data-testid="connected-app-row">
                  <ItemContent>
                    <ItemTitle>{app.clientName}</ItemTitle>
                    <ItemDescription>
                      {app.redirectHost} · Connected {formatDay(app.createdAt)} · {app.lastUsedAt ? `Last used ${formatDay(app.lastUsedAt)}` : "Never used"}
                    </ItemDescription>
                    <div className="flex flex-wrap gap-[var(--space-1)] mt-[var(--space-1)]">
                      {app.scopes.map((scope) => <Badge key={scope} variant={scope === "admin" ? "warning-light" : "secondary"}>{SCOPE_LABEL[scope] ?? scope}</Badge>)}
                    </div>
                  </ItemContent>
                  <ItemActions>
                    <Button type="button" variant="outline" onClick={() => setRevoking(app)}>Revoke<span className="sr-only"> {app.clientName}</span></Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          )}
        </FramePanel>
      </Frame>

      <AlertDialog open={revoking !== null} onOpenChange={(open) => { if (!open && !pending) setRevoking(null); }}>
        <AlertDialogContent size="default" data-testid="connected-app-revoke-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revoking?.clientName}?</AlertDialogTitle>
            <AlertDialogDescription className="text-foreground-secondary">It will stop working immediately. You can connect it again later.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="connected-app-revoke-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" data-testid="connected-app-revoke-action" disabled={pending} onClick={() => void revoke()}>{pending ? "Revoking…" : "Revoke"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
