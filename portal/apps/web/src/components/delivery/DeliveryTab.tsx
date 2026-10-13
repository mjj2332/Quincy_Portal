import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileTextIcon, FilmIcon } from "lucide-react";
import type { DeliveryPageDto, Role } from "@quincy/shared";
import { ApiError } from "../../lib/api";
import { useCapabilities } from "../../lib/capabilities";
import { COLLECTION_OF_KIND, toDeliveryCandidates, type DeliveryCandidate } from "../../lib/delivery-candidates";
import { deliveryErrorText, errorCode, previewDelivery, publishDelivery, refusedAssetIds, setAssetPremium, setAssetPremiumUnlock, setDeliveryPageEnabled, setDeliveryVideoPremium, setDeliveryVideoPremiumUnlock, useDeliveryCandidatesQuery, useProjectDeliveryQuery } from "../../lib/delivery-data";
import { readPendingPublish, writePendingPublish } from "../../lib/delivery-pending-store";
import { invalidateProjectSurfaces, projectDataKeys, useProjectDetailQuery, type ProjectDetail } from "../../lib/project-data";
import { LazyImage } from "../LazyImage";
import { Checkbox } from "../quincy/Checkbox";
import { Notice } from "../quincy/Notice";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../reui/alert-dialog";
import { Badge } from "../reui/badge";
import { Button } from "../reui/button";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "../reui/frame";
import { Input } from "../reui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "../reui/item";
import { Label } from "../reui/label";
import { Switch } from "../reui/switch";
import { Toggle } from "../reui/toggle";
import { CopyTextButton } from "../video/CopyTextButton";
import { REVIEW_STATUS_LABEL } from "../video/VideoReviewStatusPill";
import { DeliveryPreviewDialog } from "./DeliveryPreviewDialog";

/**
 * The staff Delivery tab (#787 slice 10): choose what the client page shows, pick a cover, Preview, Publish, then the page's address, the Admin on/off switch and per-item premium. Reuse
 * ledger: docs/plans/787-10-ledger.md. The tab exists only while `useProjectDeliveryQuery` answered with a page state (gate open, `viewClientPreview`), which the Workspace decides.
 * Publish is idempotent by operation id: one id per (selection, cover, page the person saw), so a retry of the same attempt cannot publish twice and a changed attempt takes a new id.
 */
const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";
const GROUPS = [{ kind: "photo", title: "Edited photos", plural: "photos" }, { kind: "floorplan", title: "Floorplan PDF", plural: "Floorplan PDFs" }, { kind: "copy", title: "Copy PDF", plural: "Copy PDFs" }, { kind: "video", title: "Videos", plural: "Videos" }] as const;
const when = (epoch: number) => new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(epoch));
const thumbUrl = (projectId: string, c: DeliveryCandidate) => (c.kind === "photo" || c.kind === "video" ? `/api/projects/${projectId}/delivery/preview-media/${c.assetId}/thumb` : null);
/** A refusal the server gave is definite; no answer at all, or a server fault, may still have committed. */
const uncertain = (error: unknown) => !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
type Unlocking = { candidate: DeliveryCandidate; mode: "unlock" | "relock" } | null;

export function DeliveryTab({ projectId, role, archived, active }: { projectId: string; role: Role; archived: boolean; active: boolean }) {
  const { can } = useCapabilities();
  const queryClient = useQueryClient();
  const delivery = useProjectDeliveryQuery(projectId, true);
  const listed = useDeliveryCandidatesQuery(projectId, true);
  const state = delivery.data ?? null;
  const candidates = useMemo(() => toDeliveryCandidates(listed.data?.candidates ?? []), [listed.data]);
  const detail = useProjectDetailQuery(projectId, false, false, role); // observed only: the Workspace owns the read
  // A list that failed (or is still loading) has no data, and a selection seeded without it would silently drop its items.
  const listsUsable = listed.data !== undefined;
  const listsFailed = listed.isError && !listed.data ? listed : undefined;

  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [cover, setCover] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [preview, setPreview] = useState<DeliveryPageDto | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"preview" | "publish" | "switch" | null>(null);
  const [rowBusy, setRowBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [unlocking, setUnlocking] = useState<Unlocking>(null);
  const [paymentRef, setPaymentRef] = useState("");
  // After an archive refusal the tab is read-only before the Project is re-read: `Infinity` until that re-read answers, then the time of the answering read, which only a LATER read showing
  // the Project unarchived (restored in another tab) may lift.
  const [archivedLatch, setArchivedLatch] = useState<number | null>(null);
  const [seeded, setSeeded] = useState(false);
  // What a Publish is, from the moment it is first tried until it is answered, lives in a store owned by the session and Project (not this component): a lost response leaves it unanswered, and a retry sends exactly this.
  const pending = { get current() { return readPendingPublish(queryClient, projectId); }, set current(value) { writePendingPublish(queryClient, projectId, value); } };
  const [, rerender] = useState(0);
  const isArchived = archived || archivedLatch !== null;
  // The tab stays mounted while hidden: coming back to it asks for the candidates again, so what was uploaded, replaced or trashed meanwhile is offered (or no longer offered).
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) void listed.refetch();
    wasActive.current = active;
  }, [active, listed]);
  const detailArchivedAt = detail.data?.archivedAt;
  useEffect(() => {
    if (archivedLatch !== null && detail.data && !detailArchivedAt && detail.dataUpdatedAt > archivedLatch) setArchivedLatch(null);
  }, [archivedLatch, detail.data, detailArchivedAt, detail.dataUpdatedAt]);

  // The first time the page and EVERY list are in, start from the current set: re-publishing is usually an edit of what is there. Until then Publish is off.
  useEffect(() => {
    if (seeded || !listsUsable || delivery.isPending) return;
    setSeeded(true);
    if (!state?.set) {
      // A first Publish (PRD §6.7: all ticked by default): everything is in, and the first photo is the cover (the PRD names no default cover; the page needs one, and the person can change it).
      setSelected(new Set(candidates.map((c) => c.assetId)));
      setCover(candidates.find((c) => c.kind === "photo")?.assetId ?? null);
      return;
    }
    const inSet = new Set(state.set.items.map((item) => item.assetId));
    // A later Publish starts from the current set plus the Videos already Approved (internal) (#864). Seeded once, so a Video the person cleared is never re-ticked. (A first Publish above already has everything ticked.)
    const start = candidates.filter((c) => inSet.has(c.assetId) || c.reviewStatus === "approved_internal").map((c) => c.assetId);
    setSelected(new Set(start));
    setCover(state.set.coverAssetId && start.includes(state.set.coverAssetId) ? state.set.coverAssetId : null);
  }, [seeded, listsUsable, delivery.isPending, candidates, state]);

  const orderedIds = candidates.filter((c) => selected.has(c.assetId)).map((c) => c.assetId);
  // The cover sent is null unless it is still a selected, eligible photo; a candidate refresh that drops it clears it here too.
  const coverIsValid = cover !== null && orderedIds.includes(cover) && candidates.some((c) => c.assetId === cover && c.kind === "photo");
  const sentCover = coverIsValid ? cover : null;
  useEffect(() => { if (seeded && cover !== null && listsUsable && !coverIsValid) setCover(null); }, [seeded, cover, listsUsable, coverIsValid]);
  // Videos in `ids` still In review (#864): advisory only, never blocks Publish. A retry sends its frozen body, so the warning reads that rather than the live selection.
  const inReviewIn = (ids: readonly string[]) => candidates.filter((c) => c.kind === "video" && c.reviewStatus === "in_review" && ids.includes(c.assetId));
  const inReviewNotice = (ids: readonly string[], testId: string) => {
    const warned = inReviewIn(ids);
    return warned.length === 0 ? null : <Notice tone="caution" role="status" data-testid={testId}>{`Still ${REVIEW_STATUS_LABEL.in_review}: ${warned.map((c) => c.name).join(", ")}. ${warned.length === 1 ? "This Video has" : "These Videos have"} not been ${REVIEW_STATUS_LABEL.approved_internal}.`}</Notice>;
  };
  const nameOf = (assetId: string) => candidates.find((c) => c.assetId === assetId)?.name ?? "an item";
  const expected = state?.page?.latestSetNumber ?? null;
  // Items the client page serves that are no longer candidates (a newer version replaced them): the page still shows THESE Assets, so their premium state is theirs to change.
  const served = useMemo<DeliveryCandidate[]>(() => {
    const known = new Set(candidates.map((c) => c.assetId));
    return (state?.set?.items ?? []).filter((item) => !known.has(item.assetId)).map((item) => ({
      assetId: item.assetId, kind: item.kind, name: `${item.label} (older version)`, collection: COLLECTION_OF_KIND[item.kind], premium: item.premium, premiumUnlocked: item.premiumUnlocked, videoId: item.videoId, reviewStatus: null,
    }));
  }, [candidates, state]);
  const surfaces = (collection?: "edited" | "floorplan" | "copy" | null) => invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "delivery" }, { kind: "delivery-candidates" }, ...(collection ? [{ kind: "assets", collectionKind: collection } as const] : [])], dashboard: false, calendar: false, gantt: false });

  function toggleSelected(assetId: string, on: boolean) {
    setSelected((current) => { const next = new Set(current); if (on) next.add(assetId); else next.delete(assetId); return next; });
    if (!on && cover === assetId) setCover(null);
  }
  function toggleGroup(kind: DeliveryCandidate["kind"], on: boolean) {
    const members = candidates.filter((c) => c.kind === kind).map((c) => c.assetId);
    setSelected((current) => { const next = new Set(current); for (const id of members) { if (on) next.add(id); else next.delete(id); } return next; });
    if (!on && cover && members.includes(cover)) setCover(null);
  }
  /** An archive refusal makes the tab read-only now; the Project is then re-read, and an authoritative "not archived" lifts it. */
  async function latchArchived() {
    const refusedAt = Date.now();
    setArchivedLatch(Infinity);
    try { await invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "detail" }], dashboard: false, calendar: false, gantt: false }); } catch { /* the read below says whether it answered */ }
    // Only a read that SUCCEEDED after the refusal is authoritative. A failed refresh leaves the older cached Project (which may say "not archived") in place, so it keeps the latch; any later successful read decides.
    const answered = queryClient.getQueryState<ProjectDetail>(projectDataKeys.detail(projectId));
    const authoritative = answered?.status === "success" && answered.dataUpdatedAt >= refusedAt && answered.data;
    setArchivedLatch(authoritative ? (authoritative.archivedAt ? answered.dataUpdatedAt : null) : Date.now());
  }
  function refuse(error: unknown) {
    const code = errorCode(error);
    const refused = code === "invalid_selection" ? refusedAssetIds(error) : [];
    if (refused.length) { setSelected((current) => new Set([...current].filter((id) => !refused.includes(id)))); if (cover && refused.includes(cover)) setCover(null); }
    if (code === "project_archived") void latchArchived();
    if (code === "stale_set") void surfaces();
    setProblem(deliveryErrorText(error, refused.map(nameOf)));
  }

  async function runPreview() {
    setBusy("preview"); setProblem(null); setReceipt(null);
    try { setPreview(await previewDelivery(queryClient, projectId, { assetIds: orderedIds, coverAssetId: sentCover })); } catch (error) { refuse(error); } finally { setBusy(null); }
  }
  async function runPublish() {
    setConfirming(false); setBusy("publish"); setProblem(null); setReceipt(null);
    // An unanswered Publish keeps its id and body whatever has changed since; only an answer releases it.
    if (!pending.current) pending.current = { id: crypto.randomUUID(), body: { assetIds: orderedIds, coverAssetId: sentCover, expectedLatestSet: expected } };
    const attempt = pending.current;
    try {
      const response = await publishDelivery(queryClient, projectId, { ...attempt.body, operationId: attempt.id });
      // Only this attempt's own answer releases it: a discarded earlier attempt answering late must not drop a newer one's retry identity.
      if (pending.current?.id === attempt.id) pending.current = null;
      setReceipt(response.replayed ? `This was already published as set ${response.operationSetNumber}.` : `Published as set ${response.operationSetNumber}.`);
    } catch (error) { if (!uncertain(error) && pending.current?.id === attempt.id) pending.current = null; refuse(error); } finally { setBusy(null); rerender((n) => n + 1); }
  }
  async function runSwitch(enabled: boolean) {
    setBusy("switch"); setProblem(null);
    try { await setDeliveryPageEnabled(queryClient, projectId, enabled); } catch (error) { setProblem(deliveryErrorText(error)); void surfaces(); } finally { setBusy(null); }
  }
  async function writeRow(c: DeliveryCandidate, write: () => Promise<unknown>) {
    setProblem(null); setRowBusy((current) => new Set(current).add(c.assetId));
    try { await write(); } catch (error) { if (errorCode(error) === "project_archived") void latchArchived(); setProblem(deliveryErrorText(error)); void surfaces(c.collection === "edited" || c.collection === "floorplan" || c.collection === "copy" ? c.collection : null); }
    finally { setRowBusy((current) => { const next = new Set(current); next.delete(c.assetId); return next; }); }
  }
  const canPremium = (c: DeliveryCandidate) => can(c.kind === "video" ? "manageVideoPremium" : "manageExtras");
  const markPremium = (c: DeliveryCandidate, premium: boolean) => writeRow(c, () => (c.kind === "video" ? setDeliveryVideoPremium(queryClient, projectId, c.videoId!, premium) : setAssetPremium(queryClient, projectId, c.assetId, c.collection!, premium)));
  const setUnlocked = (c: DeliveryCandidate, unlocked: boolean, ref: string) => writeRow(c, () => (c.kind === "video"
    ? setDeliveryVideoPremiumUnlock(queryClient, projectId, c.videoId!, { unlocked, ...(unlocked && ref ? { paymentRef: ref } : {}) })
    : setAssetPremiumUnlock(queryClient, projectId, c.assetId, c.collection!, { unlocked, ...(unlocked && ref ? { paymentRef: ref } : {}) })));

  const premiumControls = (c: DeliveryCandidate) => {
    if (!canPremium(c)) return null;
    const working = rowBusy.has(c.assetId);
    return <>
      <label data-testid="delivery-premium-hit" className={`inline-flex items-center gap-[var(--space-2)] [font:var(--type-label)] text-foreground-secondary ${TOUCH}`}>
        <Switch aria-label={`Premium ${c.name}`} size="sm" checked={c.premium} disabled={isArchived || working} onCheckedChange={(next) => void markPremium(c, next)} />
        Premium
      </label>
      {c.premium && <Button type="button" variant="outline" className={TOUCH} aria-label={`${c.premiumUnlocked ? "Re-lock" : "Unlock"} ${c.name}`} disabled={isArchived || working} onClick={() => { setPaymentRef(""); setUnlocking({ candidate: c, mode: c.premiumUnlocked ? "relock" : "unlock" }); }}>{c.premiumUnlocked ? "Re-lock" : "Unlock"}</Button>}
    </>;
  };

  const page = state?.page ?? null;
  const address = page ? `${window.location.origin}${page.path}` : null;
  const none = orderedIds.length === 0;

  return <div data-testid="delivery-tab" className="grid min-w-0 gap-[var(--space-4)] p-[var(--space-1)]">
    {isArchived && <Notice tone="caution" role="status" data-testid="delivery-archived">This project is archived. Preview and the page address still work; publishing and premium are read-only until it is restored.</Notice>}
    {problem && <Notice tone="critical" role="alert" data-testid="delivery-problem">{problem}</Notice>}
    {receipt && <Notice tone="positive" role="status" data-testid="delivery-receipt">{receipt}</Notice>}

    {page && address && <Frame data-surface="default" aria-label="Client page address" role="group">
      <FramePanel className="grid gap-[var(--space-3)]">
        <FrameHeader className="p-0">
          <div className="flex flex-wrap items-center gap-[var(--space-2)]">
            <FrameTitle>Client page</FrameTitle>
            <Badge variant={page.enabled ? "success-light" : "outline"} data-testid="delivery-page-state">{page.enabled ? "On" : "Off"}</Badge>
          </div>
          <FrameDescription className="text-foreground-secondary">Share this address with the client. Premium items stay locked on it until you unlock them.</FrameDescription>
        </FrameHeader>
        <div className="flex flex-wrap items-center gap-[var(--space-2)]">
          <span data-testid="delivery-address" className="min-w-0 [overflow-wrap:anywhere] [font:var(--type-body)]">{address}</span>
          <CopyTextButton text={address} label="Copy address" success="Address copied." failure="Couldn't copy the address." className={TOUCH} />
        </div>
        {state?.set && <p className="m-0 text-foreground-secondary [font:var(--type-label)]"><span data-testid="delivery-set-number">{`Set ${state.set.setNumber}`}</span> · <span data-testid="delivery-published-at">{`Published ${when(state.set.publishedAt)}`}</span></p>}
        {can("switchDeliveryPage") && <label data-testid="delivery-page-hit" className={`flex w-fit items-center gap-[var(--space-3)] [font:var(--type-label)] ${TOUCH}`}>
          <Switch aria-label="Client page" checked={page.enabled} disabled={busy === "switch"} onCheckedChange={(next) => void runSwitch(next)} />
          {page.enabled ? "Page is live for the client" : "Page is switched off"}
        </label>}
      </FramePanel>
    </Frame>}

    <Frame data-surface="default" aria-label="What to publish" role="group">
      <FramePanel className="grid gap-[var(--space-4)]">
        <FrameHeader className="p-0">
          <FrameTitle>What to publish</FrameTitle>
          <FrameDescription className="text-foreground-secondary">{`Choose the items for the client page${candidates.some((c) => c.kind === "photo") ? ", then a cover photo" : ""}. ${orderedIds.length} selected.`}</FrameDescription>
        </FrameHeader>
        {(!listsUsable || delivery.isPending) && !listsFailed && <p role="status" className="m-0 text-foreground-secondary [font:var(--type-label)]">Loading what can be published…</p>}
        {listsFailed && <Notice tone="critical" role="alert" className="flex flex-wrap items-center justify-between gap-[var(--space-2)]"><span>The items could not be loaded.</span><Button type="button" variant="outline" className={TOUCH} onClick={() => void listsFailed.refetch()}>Retry</Button></Notice>}
        {listsUsable && candidates.length === 0 && <p className="m-0 text-foreground-secondary [font:var(--type-label)]">Nothing is ready to publish yet. Edited photos, the Floorplan and Copy PDFs and Videos appear here once they are in.</p>}
        {GROUPS.map((group) => {
          const members = candidates.filter((c) => c.kind === group.kind);
          if (members.length === 0) return null;
          const all = members.every((c) => selected.has(c.assetId));
          return <section key={group.kind} aria-labelledby={`delivery-group-${group.kind}`} className="grid gap-[var(--space-2)]">
            <div className="flex flex-wrap items-center justify-between gap-[var(--space-2)]">
              <h3 id={`delivery-group-${group.kind}`} className="m-0 [font:var(--type-label)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary">{group.title}</h3>
              <Button type="button" variant="ghost" className={TOUCH} onClick={() => toggleGroup(group.kind, !all)}>{all ? `Clear ${group.plural.toLowerCase()}` : `Select all ${group.plural.toLowerCase()}`}</Button>
            </div>
            <ItemGroup>
              {members.map((c) => {
                const on = selected.has(c.assetId); const isLocked = c.premium && !c.premiumUnlocked; const url = isLocked && c.kind === "video" ? null : thumbUrl(projectId, c); // a locked film has no poster to show staff (the server refuses it), so it is the icon tile const working = rowBusy.has(c.assetId);
                return <Item key={c.assetId} size="xs" variant="outline" data-testid="delivery-item" data-kind={c.kind} className="flex-wrap">
                  <label className="grid size-11 shrink-0 place-items-center"><Checkbox aria-label={`Select ${c.name}`} checked={on} onChange={(event) => toggleSelected(c.assetId, event.target.checked)} /></label>
                  <ItemMedia variant="image" className="size-14 overflow-hidden bg-surface-sunken text-foreground-secondary group-data-[size=xs]/item:size-14 group-has-data-[slot=item-description]/item:translate-y-0 group-has-data-[slot=item-description]/item:self-center">
                    {url ? <LazyImage key={`${isLocked}:${url}`} src={url} alt="" className="size-full object-cover" /> : c.kind === "video" ? <FilmIcon aria-hidden className="size-5" /> : <FileTextIcon aria-hidden className="size-5" />}
                  </ItemMedia>
                  <ItemContent className="min-w-0 flex-[1_1_12rem]">
                    <ItemTitle className="line-clamp-none [overflow-wrap:anywhere]">{c.name}</ItemTitle>
                    {c.premium && <ItemDescription className="line-clamp-none flex flex-wrap items-center gap-[var(--space-2)]">
                      <Badge variant={c.premiumUnlocked ? "success-light" : "warning-light"}>{c.premiumUnlocked ? "Premium · unlocked" : "Premium · locked"}</Badge>
                    </ItemDescription>}
                  </ItemContent>
                  <ItemActions className="flex-wrap">
                    {c.kind === "photo" && on && <Toggle variant="outline" size="sm" aria-label={`Cover ${c.name}`} pressed={cover === c.assetId} onPressedChange={(pressed) => setCover(pressed ? c.assetId : null)}>Cover</Toggle>}
                    {premiumControls(c)}
                  </ItemActions>
                </Item>;
              })}
            </ItemGroup>
          </section>;
        })}
        {served.length > 0 && <section aria-labelledby="delivery-group-served" className="grid gap-[var(--space-2)]">
          <h3 id="delivery-group-served" className="m-0 [font:var(--type-label)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary">Older versions on the page now</h3>
          <p className="m-0 text-foreground-secondary [font:var(--type-label)]">The client page still shows these, because a newer version has not been published. Locking and unlocking here changes what the client sees.</p>
          <ItemGroup>
            {served.map((c) => <Item key={c.assetId} size="xs" variant="outline" data-testid="delivery-served-item" data-kind={c.kind} className="flex-wrap">
              <ItemContent className="min-w-0 flex-[1_1_12rem]">
                <ItemTitle className="line-clamp-none [overflow-wrap:anywhere]">{c.name}</ItemTitle>
                {c.premium && <ItemDescription className="line-clamp-none flex flex-wrap items-center gap-[var(--space-2)]">
                  <Badge variant={c.premiumUnlocked ? "success-light" : "warning-light"}>{c.premiumUnlocked ? "Premium · unlocked" : "Premium · locked"}</Badge>
                </ItemDescription>}
              </ItemContent>
              <ItemActions className="flex-wrap">{premiumControls(c)}</ItemActions>
            </Item>)}
          </ItemGroup>
        </section>}
        {inReviewNotice(orderedIds, "delivery-in-review-inline")}
        <div className="flex flex-wrap items-center gap-[var(--space-2)]">
          <Button type="button" variant="outline" data-testid="delivery-preview" className={TOUCH} disabled={none || busy !== null} onClick={() => void runPreview()}>Preview</Button>
          <Button type="button" data-testid="delivery-publish" className={TOUCH} disabled={(none && !pending.current) || busy !== null || isArchived || !seeded} onClick={() => { setProblem(null); setConfirming(true); }}>{pending.current ? "Retry publish" : page ? "Publish a new set" : "Publish"}</Button>
          {!seeded && <span data-testid="delivery-publish-reason" className="text-foreground-secondary [font:var(--type-label)]">{listsFailed ? "Publish is off because some items could not be loaded. Retry them above." : "Publish is off while the items are loading."}</span>}
          {pending.current && <Button type="button" variant="ghost" data-testid="delivery-discard-retry" className={TOUCH} disabled={busy !== null} onClick={() => { pending.current = null; setProblem(null); rerender((n) => n + 1); }}>Discard unfinished publish</Button>}
        </div>
      </FramePanel>
    </Frame>

    <DeliveryPreviewDialog dto={preview} onClose={() => setPreview(null)} />

    <AlertDialog open={confirming} onOpenChange={(open) => { if (!open) setConfirming(false); }}>
      <AlertDialogContent size="default">
        <AlertDialogHeader>
          <AlertDialogTitle>{pending.current ? `Retry the unfinished publish (${pending.current.body.assetIds.length} item${pending.current.body.assetIds.length === 1 ? "" : "s"})?` : `Publish ${orderedIds.length} item${orderedIds.length === 1 ? "" : "s"}?`}</AlertDialogTitle>
          <AlertDialogDescription>{pending.current ? "The earlier attempt may or may not have gone through. This sends it again exactly as it was; the server publishes it only once." : page ? "This replaces what the client sees with this selection as the next set." : detail.data?.stageKey === "delivered" ? "This creates the client page." : "This creates the client page. The first Publish also moves the Project to Delivered."}</AlertDialogDescription>
        </AlertDialogHeader>
        {inReviewNotice(pending.current?.body.assetIds ?? orderedIds, "delivery-in-review-warning")}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction data-testid="delivery-publish-confirm" onClick={() => void runPublish()}>Publish</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={unlocking !== null} onOpenChange={(open) => { if (!open) setUnlocking(null); }}>
      <AlertDialogContent size="default">
        <AlertDialogHeader>
          <AlertDialogTitle>{unlocking?.mode === "relock" ? `Re-lock ${unlocking.candidate.name}?` : `Unlock ${unlocking?.candidate.name ?? ""}?`}</AlertDialogTitle>
          <AlertDialogDescription>{unlocking?.mode === "relock" ? "The client sees a locked preview again and downloads stop until it is unlocked." : "The client can open and download it on the page. Add a payment reference so the unlock can be traced."}</AlertDialogDescription>
        </AlertDialogHeader>
        {unlocking?.mode === "unlock" && <div className="grid gap-[var(--space-2)]">
          <Label htmlFor="delivery-payment-ref">Payment reference (optional)</Label>
          <Input id="delivery-payment-ref" data-testid="delivery-payment-ref" maxLength={200} autoComplete="off" value={paymentRef} onChange={(event) => setPaymentRef(event.target.value)} />
        </div>}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={unlocking?.mode === "relock" ? "destructive" : "default"} data-testid={unlocking?.mode === "relock" ? "delivery-relock-confirm" : "delivery-unlock-confirm"} onClick={() => { if (unlocking) void setUnlocked(unlocking.candidate, unlocking.mode === "unlock", paymentRef.trim()); setUnlocking(null); }}>{unlocking?.mode === "relock" ? "Re-lock" : "Unlock"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}
