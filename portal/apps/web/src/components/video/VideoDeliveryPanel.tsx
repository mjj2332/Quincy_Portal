import { useState, useSyncExternalStore, type ReactNode } from "react";
import { roleHasCapability, type Role, type VideoDecisionEvent, type VideoDto, type VideoVersionDto } from "@quincy/shared";
import { useOptionalProjectQueryClient } from "../../lib/project-data";
import { recordClientDecision, releaseVideoVersion, setVideoPremium, setVideoPremiumUnlock, useVideoDecisionsQuery, withdrawVideoRelease } from "../../lib/video-approval-data";
import { versionSlot, videoSlot, type VideoApprovalStore } from "../../lib/video-approval-store";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../reui/alert-dialog";
import { Badge } from "../reui/badge";
import { Button } from "../reui/button";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "../reui/frame";
import { Input } from "../reui/input";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "../reui/item";
import { Label } from "../reui/label";
import { Switch } from "../reui/switch";
import { Textarea } from "../reui/textarea";
import { Notice } from "../quincy/Notice";

const formatWhen = (iso: string): string => new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";
const actorName = (event: VideoDecisionEvent): string => (event.actor.kind === "user" ? event.actor.person.name : event.actor.name ?? "A guest");
const decisionLabel = (event: VideoDecisionEvent): string => (event.decision === "approved" ? "Approved" : "Requested changes");
type Pending = { kind: "release"; revision: number } | { kind: "withdraw" } | { kind: "record"; decision: "approved" | "changes_requested" } | { kind: "unlock" } | { kind: "relock" } | null;

/**
 * Decisions, Release and premium for the Version on screen (#741 14-ui-staff), shown under the player when the Project's `delivery` part is on. Reads every decision the Version has,
 * says where it stands (no decision, changes requested, approved, released), and offers Release (citing the approval revision the person saw, so a newer decision is refused by the
 * server and not silently overridden), Withdraw, and a client decision staff record themselves (the client approved by phone). Premium belongs to the Video: the switch and
 * Unlock / Re-lock need `manageVideoPremium`, which an Editor lacks. Writes go through `store`, so they and an unsent note outlive this component.
 */
export function VideoDeliveryPanel({ projectId, role, archived, video, version, store }: { projectId: string; role: Role; archived: boolean; video: VideoDto; version: VideoVersionDto; store: VideoApprovalStore }): ReactNode {
  const queryClient = useOptionalProjectQueryClient();
  const decisions = useVideoDecisionsQuery(projectId, video.id, true);
  const vSlot = versionSlot(version.assetId);
  const fSlot = videoSlot(video.id);
  const versionState = useSyncExternalStore(store.subscribe, () => store.getSlot(vSlot));
  const videoState = useSyncExternalStore(store.subscribe, () => store.getSlot(fSlot));
  const [pending, setPending] = useState<Pending>(null);
  const canRelease = roleHasCapability(role, "releaseVideo");
  const canPremium = roleHasCapability(role, "manageVideoPremium");

  const current = decisions.data?.versions.find((candidate) => candidate.assetId === version.assetId);
  const events = current?.events ?? [];
  const latest = events.at(-1) ?? null;
  const live = current?.release ?? null;
  const loaded = current !== undefined;
  const busy = versionState.op !== null;
  const premiumBusy = videoState.op !== null;
  const reason = archived ? "This project is archived, so approvals, releases and premium are read-only."
    : !loaded ? "Loading the client's decisions."
    : latest === null ? "Release needs a client approval, and there is no decision yet."
    : latest.decision !== "approved" ? "Release needs a client approval, and the latest decision asks for changes."
    : null;

  const context = { queryClient: queryClient!, projectId, videoId: video.id, assetId: version.assetId };
  const send = (slot: string, kind: Parameters<VideoApprovalStore["run"]>[1], write: () => Promise<unknown>) => { if (queryClient) void store.run(slot, kind, write); };
  const close = () => setPending(null);

  const state: { label: string; variant: "success" | "info-light" | "warning-light" | "outline" } = live ? { label: "Released", variant: "success" }
    : latest === null ? { label: "No client decision", variant: "outline" }
    : latest.decision === "approved" ? { label: "Approved, ready to release", variant: "info-light" }
    : { label: "Changes requested", variant: "warning-light" };
  const problem = versionState.problem ?? videoState.problem;
  const ordered = [...events].reverse();

  return <Frame data-testid="video-delivery" data-surface="default" aria-label={`Delivery of version ${version.version}`} role="group" className="shrink-0 text-foreground">
    <FramePanel className="grid gap-[var(--space-4)]">
      <FrameHeader className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-[var(--space-2)]">
          <FrameTitle>{`Delivery · v${version.version}`}</FrameTitle>
          <Badge variant={state.variant} data-testid="delivery-state">{state.label}</Badge>
        </div>
        <FrameDescription className="text-foreground-secondary">{live ? `Released ${formatWhen(live.releasedAt)}${live.releasedBy ? ` by ${live.releasedBy.name}` : ""}. Withdraw it to stop the client downloading.` : "Client decisions on this version. Only an approval can be released."}</FrameDescription>
      </FrameHeader>

      {decisions.isError && !decisions.data && <Notice tone="critical" role="alert" className="flex flex-wrap items-center justify-between gap-[var(--space-2)]"><span>{decisions.error.message || "Decisions could not be loaded."}</span><Button type="button" variant="outline" className={TOUCH} onClick={() => { void decisions.refetch(); }}>Retry</Button></Notice>}
      {loaded && events.length === 0 && <p data-testid="delivery-empty" className="m-0 text-foreground-secondary [font:var(--type-label)]">The client has not decided on this version.</p>}
      {ordered.length > 0 && <ItemGroup>
        {ordered.map((event) => <Item key={event.id} size="xs" className="px-0" data-testid="delivery-decision">
          <ItemContent>
            <ItemTitle>{`${actorName(event)} · ${decisionLabel(event)}`}</ItemTitle>
            <ItemDescription className="text-foreground-secondary">{`${formatWhen(event.at)} · ${event.link ? (event.link.label ? `Review link “${event.link.label}”` : "Review link") : "Recorded by staff"}`}</ItemDescription>
            {event.note && <ItemDescription data-testid="delivery-decision-note" className="line-clamp-none whitespace-pre-wrap text-foreground">{event.note}</ItemDescription>}
          </ItemContent>
        </Item>)}
      </ItemGroup>}

      {archived && <p data-testid="delivery-readonly" className="m-0 text-foreground-secondary [font:var(--type-label)]">This project is archived, so approvals, releases and premium are read-only.</p>}
      {problem && <Notice tone="critical" role="alert" data-testid="delivery-problem">{problem}</Notice>}

      {canRelease && <div className="flex flex-wrap items-center gap-[var(--space-2)]">
        {live
          ? <Button type="button" variant="outline" data-testid="delivery-withdraw" className={TOUCH} disabled={archived || busy} onClick={() => { store.clearProblem(vSlot); setPending({ kind: "withdraw" }); }}>Withdraw release</Button>
          : <Button type="button" data-testid="delivery-release" className={TOUCH} disabled={reason !== null || busy} onClick={() => { store.clearProblem(vSlot); if (latest) setPending({ kind: "release", revision: latest.revision }); }}>Release</Button>}
        <Button type="button" variant="outline" data-testid="delivery-record-approved" className={TOUCH} disabled={archived || busy} onClick={() => { store.clearProblem(vSlot); setPending({ kind: "record", decision: "approved" }); }}>Record approval</Button>
        <Button type="button" variant="outline" data-testid="delivery-record-changes" className={TOUCH} disabled={archived || busy} onClick={() => { store.clearProblem(vSlot); setPending({ kind: "record", decision: "changes_requested" }); }}>Record changes requested</Button>
      </div>}
      {!live && reason !== null && !archived && <p data-testid="delivery-release-reason" className="m-0 text-foreground-secondary [font:var(--type-label)]">{reason}</p>}

      <div className="grid gap-[var(--space-2)] border-t border-border pt-[var(--space-3)]" data-testid="delivery-premium">
        <div className="flex flex-wrap items-center gap-[var(--space-3)]">
          <Switch id={`delivery-premium-${video.id}`} data-testid="delivery-premium-switch" aria-label="Premium" checked={video.premium} disabled={!canPremium || archived || premiumBusy} onCheckedChange={(next) => { send(fSlot, "premium", () => setVideoPremium(context, next)); }} />
          <Label htmlFor={`delivery-premium-${video.id}`}>Premium film</Label>
          {video.premium && <Badge variant={video.premiumUnlocked ? "success-light" : "warning-light"} data-testid="delivery-lock-state">{video.premiumUnlocked ? "Unlocked" : "Locked"}</Badge>}
          {canPremium && video.premium && (video.premiumUnlocked
            ? <Button type="button" variant="outline" data-testid="delivery-relock" className={TOUCH} disabled={archived || premiumBusy} onClick={() => { store.clearProblem(fSlot); setPending({ kind: "relock" }); }}>Re-lock</Button>
            : <Button type="button" variant="outline" data-testid="delivery-unlock" className={TOUCH} disabled={archived || premiumBusy} onClick={() => { store.clearProblem(fSlot); setPending({ kind: "unlock" }); }}>Unlock</Button>)}
        </div>
        <p className="m-0 text-foreground-secondary [font:var(--type-label)]">{video.premium ? (video.premiumUnlocked ? "The client can download released versions of this film." : "The client sees a watermark and can't download until you unlock it.") : "Turn on to watermark this film for the client until it is unlocked."}</p>
        {!canPremium && <p data-testid="delivery-premium-reason" className="m-0 text-foreground-secondary [font:var(--type-label)]">Only an Admin can change premium or unlock it.</p>}
      </div>
    </FramePanel>

    <AlertDialog open={pending?.kind === "release"} onOpenChange={(open) => { if (!open) close(); }}>
      <AlertDialogContent size="default">
        <AlertDialogHeader>
          <AlertDialogTitle>{`Release version ${version.version}?`}</AlertDialogTitle>
          <AlertDialogDescription>The client's review links that allow downloads can download this version once it is released. If the client has since changed their decision, Release is refused and nothing happens.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction data-testid="delivery-release-confirm" disabled={busy} onClick={() => { const revision = pending?.kind === "release" ? pending.revision : null; if (revision !== null) send(vSlot, "release", () => releaseVideoVersion(context, revision)); close(); }}>Release</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={pending?.kind === "withdraw"} onOpenChange={(open) => { if (!open) close(); }}>
      <AlertDialogContent size="default">
        <AlertDialogHeader>
          <AlertDialogTitle>{`Withdraw the release of version ${version.version}?`}</AlertDialogTitle>
          <AlertDialogDescription>The client can no longer download this version. Their decisions are kept.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" data-testid="delivery-withdraw-confirm" disabled={busy} onClick={() => { send(vSlot, "withdraw", () => withdrawVideoRelease(context)); close(); }}>Withdraw release</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={pending?.kind === "record"} onOpenChange={(open) => { if (!open) close(); }}>
      <AlertDialogContent size="default">
        <AlertDialogHeader>
          <AlertDialogTitle>{pending?.kind === "record" && pending.decision === "changes_requested" ? "Record that the client wants changes" : "Record that the client approved"}</AlertDialogTitle>
          <AlertDialogDescription>Use this when the client answered outside the review link, for example by phone. It is logged as your decision on their behalf.</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-[var(--space-2)]">
          <Label htmlFor="delivery-note">Note (optional)</Label>
          <Textarea id="delivery-note" data-testid="delivery-note" maxLength={2000} value={versionState.note} onChange={(event) => store.setNote(vSlot, event.target.value)} />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction data-testid="delivery-record-confirm" disabled={busy} onClick={() => {
            if (pending?.kind !== "record") return;
            const decision = pending.decision; const note = versionState.note.trim();
            send(vSlot, "decision", () => recordClientDecision(context, { decision, ...(note ? { note } : {}) }));
            close();
          }}>{pending?.kind === "record" && pending.decision === "changes_requested" ? "Record changes requested" : "Record approval"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={pending?.kind === "unlock"} onOpenChange={(open) => { if (!open) close(); }}>
      <AlertDialogContent size="default">
        <AlertDialogHeader>
          <AlertDialogTitle>Unlock this premium film?</AlertDialogTitle>
          <AlertDialogDescription>The watermark comes off and released versions can be downloaded. Add a payment reference so the unlock can be traced.</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-[var(--space-2)]">
          <Label htmlFor="delivery-payment-ref">Payment reference (optional)</Label>
          <Input id="delivery-payment-ref" data-testid="delivery-payment-ref" maxLength={200} autoComplete="off" value={videoState.paymentRef} onChange={(event) => store.setPaymentRef(fSlot, event.target.value)} />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction data-testid="delivery-unlock-confirm" disabled={premiumBusy} onClick={() => { const ref = videoState.paymentRef.trim(); send(fSlot, "unlock", () => setVideoPremiumUnlock(context, { unlocked: true, ...(ref ? { paymentRef: ref } : {}) })); close(); }}>Unlock</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={pending?.kind === "relock"} onOpenChange={(open) => { if (!open) close(); }}>
      <AlertDialogContent size="default">
        <AlertDialogHeader>
          <AlertDialogTitle>Re-lock this premium film?</AlertDialogTitle>
          <AlertDialogDescription>The watermark returns and downloads stop until it is unlocked again.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" data-testid="delivery-relock-confirm" disabled={premiumBusy} onClick={() => { send(fSlot, "relock", () => setVideoPremiumUnlock(context, { unlocked: false })); close(); }}>Re-lock</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Frame>;
}
