import { useState } from "react";
import { ChevronLeft } from "lucide-react";
import { REVIEW_LINK_LABEL_MAX, type ReviewLinkDto, type ReviewLinkPatchInput, type VideoDto } from "@quincy/shared";
import { formatCivilDay, formatRelativeTime, sydneyDayKey } from "../../lib/date-format";
import { expiryDayToIso } from "../../lib/review-link-expiry";
import { emptyDetail, type Allow } from "../../lib/review-link-form-store";
import { useNow } from "../../lib/use-now";
import { buttonClasses, Button } from "../quincy/Button";
import { Checkbox } from "../quincy/Checkbox";
import { DateTimeField } from "../quincy/DateTimeField";
import { Notice } from "../quincy/Notice";
import { QuincyField } from "../quincy/QuincyField";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../reui/alert-dialog";
import { Badge } from "../reui/badge";
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxTrigger } from "../reui/combobox";
import { DialogDescription, DialogHeader, DialogTitle } from "../reui/dialog";
import { FieldDescription } from "../reui/field";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "../reui/item";
import { formatVideoDate } from "./video-format";
import { DIALOG_FIELD_LAYER, passcodeProblem } from "./ReviewLinkCreateView";
import { ReviewLinkAllowFields } from "./ReviewLinkAllowFields";
import { activityLine, expiryLine, linkName } from "./ReviewLinkList";
import { ReviewLinkStatusBadge } from "./ReviewLinkStatusBadge";
import { useReviewLinkState, type ReviewLinksUi } from "./use-review-links-ui";

const TEXT = "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]";
const MUTED = `${TEXT} text-foreground-secondary`;
const HEADING = "[font:var(--weight-medium)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]";
const TARGET = "pointer-coarse:min-h-11 max-[721px]:min-h-11";

type Confirm = { kind: "remove"; videoId: string; title: string } | { kind: "revoke" } | { kind: "replace" };

/** Every scope a request for this link can have, so its refusals show in its detail. */
const belongsTo = (scope: string, linkId: string) => scope.split(":")[1] === linkId;

/** One link's detail (#741 11b): settings, the Versions each Video shares, Add / Remove Video, Replace and Revoke. Every unsaved edit is the store's. */
export function ReviewLinkDetail({ ui, videos, linkId }: { ui: ReviewLinksUi; videos: VideoDto[]; linkId: string }) {
  const { store, actions, links } = ui;
  const state = useReviewLinkState(store);
  const now = useNow();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const link = links.data?.find((candidate) => candidate.id === linkId);

  const back = <Button type="button" variant="text" className={`${TARGET} -ml-[var(--space-1)] justify-start`} onClick={store.openList}><ChevronLeft aria-hidden="true" className="size-4" />All links</Button>;
  if (!link) {
    return <div data-testid="review-link-detail" className="grid gap-[var(--space-3)]">
      <DialogHeader><DialogTitle>Review link</DialogTitle><DialogDescription>{links.isPending ? "Loading…" : "This Review link no longer exists."}</DialogDescription></DialogHeader>
      {back}
    </div>;
  }

  const revoked = link.status === "revoked";
  const expired = link.status === "expired";
  const locked = revoked || ui.archived;
  const draft = state.details[linkId] ?? emptyDetail();
  const currentDay = sydneyDayKey(link.expiresAt);
  const labelValue = draft.label ?? link.label ?? "";
  const expiryValue = draft.expiryDay ?? currentDay;
  const allowValue: Allow = { ...link.allow, ...draft.allow };
  const labelChanged = draft.label !== null && draft.label.trim() !== (link.label ?? "");
  const expiryChanged = draft.expiryDay !== null && draft.expiryDay !== currentDay;
  const passcodeTyped = draft.passcode.trim() !== "";
  const passcodeChanged = passcodeTyped || draft.removePasscode;
  const allowChanges = (Object.keys(draft.allow) as Array<keyof Allow>).filter((key) => draft.allow[key] !== link.allow[key]);
  const dirty = labelChanged || expiryChanged || passcodeChanged || allowChanges.length > 0;
  const expiry = expiryChanged ? expiryDayToIso(expiryValue, now) : null;
  const passcodeError = passcodeProblem(draft.passcode);
  const saving = state.pending.has(`patch:${linkId}`);
  // One write in flight per link (see the store's `run`): while any is out, every control that would start another is off.
  const busyLink = [...state.pending].some((scope) => belongsTo(scope, linkId));
  const canSave = !locked && dirty && !busyLink && passcodeError === null && (expiry === null || expiry.ok);
  const problems = Object.entries(state.problems).filter(([scope]) => belongsTo(scope, linkId));
  const memberIds = new Set(link.videos.map((member) => member.videoId));
  const available = videos.filter((video) => !memberIds.has(video.id));

  function save() {
    if (!canSave) return;
    const patch: ReviewLinkPatchInput = {
      ...(labelChanged ? { label: draft.label!.trim() === "" ? null : draft.label!.trim() } : {}),
      ...(expiryChanged && expiry?.ok ? { expiresAt: expiry.iso } : {}),
      ...(draft.removePasscode ? { passcode: null } : passcodeTyped ? { passcode: draft.passcode.trim() } : {}),
      ...(allowChanges.length > 0 ? { allow: Object.fromEntries(allowChanges.map((key) => [key, allowValue[key]])) } : {}),
    };
    const sent = structuredClone(draft);
    void store.run(`patch:${linkId}`, () => actions.patch(linkId, patch), () => store.settleDetail(linkId, sent), undefined, linkId);
  }

  function toggleVersion(member: ReviewLinkDto["videos"][number], video: VideoDto | undefined, assetId: string) {
    const granted = new Set(member.grants.map((grant) => grant.assetId));
    // The complete granted set is the base: a Version the cached Video does not list (uploaded and granted elsewhere) must survive a toggle.
    const known = video ? video.versions.map((version) => version.assetId) : [];
    const order = [...known, ...member.grants.map((grant) => grant.assetId).filter((id) => !known.includes(id))];
    const next = order.filter((id) => (id === assetId ? !granted.has(id) : granted.has(id)));
    if (next.length === 0) return;
    void store.run(`grants:${linkId}:${member.videoId}`, () => actions.setGrants(linkId, member.videoId, next), () => undefined, undefined, linkId);
  }

  function run(action: Confirm) {
    setConfirm(null);
    if (action.kind === "remove") void store.run(`remove:${linkId}:${action.videoId}`, () => actions.removeVideo(linkId, action.videoId), () => undefined, undefined, linkId);
    else if (action.kind === "revoke") void store.run(`revoke:${linkId}`, () => actions.revoke(linkId), () => undefined, undefined, linkId);
    else void store.run(`replace:${linkId}`, () => actions.replace(linkId), (result) => store.showReveal({ url: result.url, linkId, label: result.link.label, origin: "replace" }), undefined, linkId);
  }

  return <div data-testid="review-link-detail" className="grid gap-[var(--space-5)]">
    <div className="grid gap-[var(--space-1)]">
      {back}
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-[var(--space-2)]">{linkName(link)}<ReviewLinkStatusBadge status={link.status} /></DialogTitle>
        <DialogDescription>{`${expiryLine(link)} · ${activityLine(link, now)}`}</DialogDescription>
      </DialogHeader>
    </div>

    {revoked && <Notice tone="caution" role="status">This link was revoked. Guests can no longer open it.</Notice>}
    {!revoked && ui.archived && <Notice tone="caution" role="status">Archived projects are read-only, so this link can't be changed. You can still revoke it.</Notice>}
    {problems.map(([scope, problem]) => <Notice key={scope} tone="critical" role="alert">{problem.text}</Notice>)}

    <section aria-label="Settings" className="grid gap-[var(--space-4)]">
      <QuincyField id="review-link-detail-label" label="Label" maxLength={REVIEW_LINK_LABEL_MAX} autoComplete="off" disabled={locked} value={labelValue} onChange={(event) => store.patchDetail(linkId, { label: event.target.value })} />
      <DateTimeField variant="date" id="review-link-detail-expiry" label="Expires" value={expiryValue} disabled={locked} positionerClassName={DIALOG_FIELD_LAYER} onApply={(next) => { if (next) store.patchDetail(linkId, { expiryDay: next === currentDay ? null : next }); }} description={expiry && !expiry.ok ? expiry.message : "The link stops working at the end of this day."} {...(expiry && !expiry.ok ? { descriptionRole: "status" as const } : {})} />
      <div className="grid gap-[var(--space-2)]">
        <QuincyField id="review-link-detail-passcode" label={link.hasPasscode ? "New passcode" : "Passcode"} autoComplete="off" spellCheck={false} disabled={locked || draft.removePasscode} value={draft.passcode} error={passcodeError} onChange={(event) => store.patchDetail(linkId, { passcode: event.target.value })} />
        {link.hasPasscode
          ? <div className="flex flex-wrap items-center gap-[var(--space-2)]">
            <FieldDescription>{draft.removePasscode ? "The passcode will be removed when you save." : "A passcode is set. Type a new one to replace it."}</FieldDescription>
            {!locked && <Button type="button" variant="text" className={TARGET} onClick={() => store.patchDetail(linkId, { removePasscode: !draft.removePasscode, passcode: "" })}>{draft.removePasscode ? "Keep passcode" : "Remove passcode"}</Button>}
          </div>
          : <FieldDescription>No passcode: anyone with the link can watch.</FieldDescription>}
      </div>
      <ReviewLinkAllowFields value={allowValue} disabled={locked} onChange={(key, next) => store.patchDetail(linkId, { allow: { ...draft.allow, [key]: next } })} />
      {!locked && <div className="flex flex-wrap justify-end gap-[var(--space-2)]">
        <Button type="button" variant="primary" className="min-h-11" disabled={!canSave} onClick={save}>{saving ? "Saving…" : "Save changes"}</Button>
      </div>}
    </section>

    <section aria-label="Films on this link" className="grid gap-[var(--space-3)]">
      <h3 className={HEADING}>Films on this link</h3>
      <ItemGroup className="gap-[var(--space-2)]">
        {link.videos.map((member) => {
          const video = videos.find((candidate) => candidate.id === member.videoId);
          const granted = new Set(member.grants.map((grant) => grant.assetId));
          // A granted Version the cached Video does not list still gets its row, so it can be seen and unticked.
          const listed = new Set((video?.versions ?? []).map((version) => version.assetId));
          const versions = [...(video?.versions ?? []), ...member.grants.filter((grant) => !listed.has(grant.assetId)).map((grant) => ({ assetId: grant.assetId, version: grant.version, current: false, uploadedBy: null, createdAt: null, unlisted: true }))];
          const busy = busyLink;
          return <Item key={member.videoId} variant="outline" data-testid="review-link-member" className="flex-wrap items-start">
            <ItemContent>
              <ItemTitle>{member.title}</ItemTitle>
              <ItemDescription className="line-clamp-none">Versions guests can watch</ItemDescription>
              <div className="grid gap-[var(--space-1)]">
                {versions.map((version) => {
                  const on = granted.has(version.assetId);
                  return <label key={version.assetId} className={`flex min-h-11 cursor-pointer items-center gap-[var(--space-3)] ${TEXT}`}>
                    <Checkbox aria-label={`${member.title} v${version.version}`} checked={on} disabled={locked || busy || (on && granted.size === 1)} onChange={() => toggleVersion(member, video, version.assetId)} />
                    <span>{"unlisted" in version ? `Version ${version.version}` : `v${version.version}${version.current ? " (current)" : ""}${version.uploadedBy && version.createdAt ? ` · ${version.uploadedBy.name} · ${formatVideoDate(version.createdAt)}` : ""}`}</span>
                  </label>;
                })}
              </div>
              {!locked && granted.size === 1 && <p className={MUTED}>Remove the Video to stop sharing it.</p>}
            </ItemContent>
            {!locked && <ItemActions>
              <Button type="button" variant="secondary" className="min-h-11" disabled={busy} aria-label={`Remove ${member.title} from link`} onClick={() => setConfirm({ kind: "remove", videoId: member.videoId, title: member.title })}>Remove</Button>
            </ItemActions>}
          </Item>;
        })}
      </ItemGroup>
      {!locked && (available.length > 0
        ? <Combobox<VideoDto> items={available} value={null} onValueChange={(video) => { if (video) void store.run(`add:${linkId}`, () => actions.addVideo(linkId, video.id, [video.currentAssetId]), () => undefined, undefined, linkId); }} itemToStringLabel={(video) => video.title} itemToStringValue={(video) => video.id} isItemEqualToValue={(a, b) => a.id === b.id}>
          <ComboboxTrigger aria-label="Add a Video" disabled={busyLink} className={buttonClasses("secondary", { className: "min-h-11 justify-between self-start" })}>{state.pending.has(`add:${linkId}`) ? "Adding…" : "Add a Video"}</ComboboxTrigger>
          <ComboboxContent className="min-w-[max(var(--anchor-width),240px)] max-w-[calc(100vw-2*var(--space-4))]">
            <ComboboxInput showTrigger={false} placeholder="Search films…" aria-label="Search films" />
            <ComboboxEmpty>No matching film</ComboboxEmpty>
            <ComboboxList aria-label="Films not on this link">
              {(video: VideoDto) => <ComboboxItem key={video.id} value={video} className="max-[721px]:min-h-[44px]">{video.title}</ComboboxItem>}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        : <p className={MUTED}>Every film is on this link.</p>)}
    </section>

    {link.activity.verifiedGuests && link.activity.verifiedGuests.length > 0 && <section aria-label="Verified guests" className="grid gap-[var(--space-2)]">
      <h3 className={HEADING}>Verified guests</h3>
      <ItemGroup className="gap-[var(--space-1)]">
        {link.activity.verifiedGuests.map((guest) => <Item key={guest.email} size="xs" className="flex-wrap">
          <ItemContent><ItemTitle className="break-all">{guest.email}</ItemTitle><ItemDescription>{`Last seen ${formatRelativeTime(guest.lastSeenAt, now)}`}</ItemDescription></ItemContent>
          {guest.unsubscribed && <ItemActions><Badge variant="secondary" size="sm">Unsubscribed</Badge></ItemActions>}
        </Item>)}
      </ItemGroup>
    </section>}

    {!revoked && <section aria-label="Danger zone" className="grid gap-[var(--space-2)]">
      <div data-testid="review-link-actions" className="flex flex-wrap gap-[var(--space-2)]">
        <Button type="button" variant="secondary" className="min-h-11" disabled={ui.archived || expired || busyLink} onClick={() => setConfirm({ kind: "replace" })}>Replace link</Button>
        <Button type="button" variant="danger" className="min-h-11" disabled={busyLink} onClick={() => setConfirm({ kind: "revoke" })}>Revoke link</Button>
      </div>
      {expired && <p className={MUTED}>Expired links can't be replaced. Extend the expiry first, then replace it.</p>}
    </section>}

    <AlertDialog open={confirm !== null} onOpenChange={(next) => { if (!next) setConfirm(null); }}>
      <AlertDialogContent size="sm" data-testid="review-link-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{confirm?.kind === "remove" ? `Remove ${confirm.title}?` : confirm?.kind === "revoke" ? "Revoke this link?" : "Replace this link?"}</AlertDialogTitle>
          <AlertDialogDescription className="text-foreground-secondary">
            {confirm?.kind === "remove" && "Guests lose access to it at once. Notes and decisions stay."}
            {confirm?.kind === "revoke" && "Guests can no longer open it, and anyone using it is signed out. This can't be undone."}
            {confirm?.kind === "replace" && "The current link stops working at once and anyone using it is signed out. You'll get a new link to share."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={confirm?.kind === "replace" ? "default" : "destructive"} onClick={() => { if (confirm) run(confirm); }}>{confirm?.kind === "remove" ? "Remove Video" : confirm?.kind === "revoke" ? "Revoke" : "Replace"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}
