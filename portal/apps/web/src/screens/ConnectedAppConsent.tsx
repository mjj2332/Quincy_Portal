import { useEffect, useState } from "react";
import { ApiError, apiGet, apiPost } from "../lib/api";
import { Eyebrow } from "@/components/quincy/Eyebrow";
import { Notice } from "@/components/quincy/Notice";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/reui/button";
import { Checkbox } from "@/components/reui/checkbox";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/reui/field";
import { Frame, FramePanel } from "@/components/reui/frame";
import { InternalLink } from "@/components/InternalLink";

type Consent = { clientName: string; redirectHost: string; isLocalhost: boolean; scopes: string[]; warning: string };
type Scope = "read" | "write" | "admin";

const PAGE = "page !max-w-[var(--container-md)]";
const HEAD = "flex flex-wrap items-end justify-between gap-[var(--space-6)] mb-[var(--space-6)]";
const H1 = "[font:var(--type-h1)] tracking-[var(--tracking-tight)] m-0";
const LEDE = "mt-[var(--space-3)] mb-0 max-w-[46ch] [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary";

const SCOPE_COPY: Record<Scope, { label: string; description: string }> = {
  read: { label: "Read", description: "See Projects, comments, notifications and the other Portal data you can see." },
  write: { label: "Write", description: "Make changes as you, such as moving Stages and posting comments." },
  admin: { label: "Admin", description: "Use admin tools as you. Access expires after 15 minutes and does not renew." },
};

/** `redirectTo` is the OAuth client's callback. The router never writes the URL, so leave with a real navigation. */
const leave = (url: string) => window.location.assign(url);

export function ConnectedAppConsent({ handle, isAdmin }: { handle: string; isAdmin: boolean }) {
  const [consent, setConsent] = useState<Consent | null>(null);
  const [expired, setExpired] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [granted, setGranted] = useState<Set<Scope>>(new Set(["read"]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiGet<Consent>(`/api/connected-apps/consent/${encodeURIComponent(handle)}`).then((value) => {
      if (!active) return;
      setConsent(value);
      // Read is locked on. Write starts ticked when the client asked for it; Admin is always an explicit opt-in.
      setGranted(new Set<Scope>(value.scopes.includes("write") ? ["read", "write"] : ["read"]));
    }, (reason) => {
      if (!active) return;
      if (reason instanceof ApiError && reason.status === 404) setExpired(true);
      else setLoadError(reason instanceof ApiError ? reason.message : "This request could not be loaded.");
    });
    return () => { active = false; };
  }, [handle]);

  async function decide(decision: "approve" | "deny") {
    setBusy(true); setError(null);
    try {
      const { redirectTo } = await apiPost<{ redirectTo: string }, { decision: string; scopes: Scope[] }>(`/api/connected-apps/consent/${encodeURIComponent(handle)}`, { decision, scopes: decision === "approve" ? [...granted] : [] });
      leave(redirectTo);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 404) setExpired(true);
      else setError(reason instanceof ApiError ? reason.message : "That could not be completed.");
      setBusy(false);
    }
  }

  function toggle(scope: Scope, on: boolean) {
    setGranted((current) => { const next = new Set(current); if (on) next.add(scope); else next.delete(scope); return next; });
  }

  const offered: Scope[] = consent ? (["read", "write", ...(isAdmin ? ["admin" as const] : [])] as Scope[]).filter((scope) => scope === "read" || consent.scopes.includes(scope)) : [];

  return (
    <main className={PAGE}>
      <header className={HEAD}>
        <div>
          <Eyebrow className="block mb-[var(--space-3)]">Personal settings</Eyebrow>
          <h1 className={H1}>Connect an app</h1>
          {!expired && <p className={LEDE}>An app is asking to act as you in the Portal.</p>}
        </div>
      </header>

      {expired && <div>
        <Notice role="alert" data-testid="consent-expired">This connection request expired or was already used. Start the connection again from the app.</Notice>
        <p className="mt-[var(--space-4)] mb-0"><InternalLink to="/settings/connected-apps" className="underline">Go to Connected apps</InternalLink></p>
      </div>}
      {loadError && <Notice role="alert">{loadError}</Notice>}
      {!consent && !expired && !loadError && <p role="status" className="m-0 text-foreground-secondary">Loading…</p>}

      {consent && !expired && (
        <Frame>
          <FramePanel>
            <h2 className="m-0 [font:var(--type-h3)] tracking-[var(--tracking-tight)]" data-testid="consent-client">{consent.clientName}</h2>
            <p className="mt-[var(--space-2)] mb-[var(--space-4)] text-foreground-secondary">
              Will return you to <strong className="text-foreground" data-testid="consent-host">{consent.redirectHost}</strong>
              {consent.isLocalhost && <> <Badge variant="warning-light" data-testid="consent-localhost">Runs on this computer</Badge></>}
            </p>
            {consent.isLocalhost && <Notice tone="caution" role="note" className="mb-[var(--space-4)]">This app runs on your own device. Any program on it could be receiving the connection, whatever name it shows.</Notice>}
            <FieldSet>
            <FieldLegend data-testid="consent-warning">{consent.warning}</FieldLegend>
            <FieldGroup>
              {offered.map((scope) => (
                <Field key={scope} orientation="horizontal">
                  <Checkbox id={`consent-scope-${scope}`} checked={granted.has(scope)} disabled={busy || scope === "read"} onCheckedChange={(next) => toggle(scope, next)} />
                  <FieldContent>
                    <FieldLabel htmlFor={`consent-scope-${scope}`}>{SCOPE_COPY[scope].label}{scope === "read" ? " (required)" : ""}</FieldLabel>
                    <FieldDescription>{SCOPE_COPY[scope].description}</FieldDescription>
                  </FieldContent>
                </Field>
              ))}
            </FieldGroup>
            </FieldSet>
            {granted.has("admin") && <Notice tone="caution" role="note" className="mt-[var(--space-4)]" data-testid="consent-admin-warning">Admin lets this app use admin tools as you, such as Dropbox, AutoHDR and retries. Only grant it to an app you trust.</Notice>}
            {error && <Notice role="alert" className="mt-[var(--space-4)]">{error}</Notice>}

            <div className="mt-[var(--space-6)] flex flex-wrap gap-[var(--space-3)] max-[721px]:flex-col">
              <Button type="button" disabled={busy} onClick={() => void decide("approve")}>{busy ? "Working…" : "Approve"}</Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => void decide("deny")}>Deny</Button>
            </div>
          </FramePanel>
        </Frame>
      )}
    </main>
  );
}
