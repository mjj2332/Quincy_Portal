import { useId, useMemo } from "react";
import { useNow } from "../../lib/use-now";
import type { ReviewLinkCreateInput, VideoDto } from "@quincy/shared";
import { REVIEW_LINK_LABEL_MAX, REVIEW_LINK_MAX_GRANTS_PER_VIDEO, REVIEW_LINK_MAX_VIDEOS, REVIEW_LINK_PASSCODE_MAX, REVIEW_LINK_PASSCODE_MIN } from "@quincy/shared";
import { defaultExpiryDay, expiryDayToIso } from "../../lib/review-link-expiry";
import { formatVideoDate } from "./video-format";
import { Button } from "../quincy/Button";
import { DateTimeField } from "../quincy/DateTimeField";
import { Notice } from "../quincy/Notice";
import { QuincyField } from "../quincy/QuincyField";
import { Checkbox } from "../quincy/Checkbox";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../reui/dialog";
import { FieldDescription, FieldError } from "../reui/field";
import { DIALOG_TITLE, ReviewLinkDialogFrame } from "./ReviewLinkDialogFrame";
import { LEGEND, ReviewLinkAllowFields } from "./ReviewLinkAllowFields";
import { useReviewLinkState, type ReviewLinksUi } from "./use-review-links-ui";

/** Shown beside a film whose Versions have reached the most one link can share. */
export const GRANT_LIMIT_HINT = `A film can share up to ${REVIEW_LINK_MAX_GRANTS_PER_VIDEO} Versions on a link.`;
export const DIALOG_FIELD_LAYER = "z-[calc(var(--z-dialog)+1)]";
export const passcodeProblem = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed === "" || (trimmed.length >= REVIEW_LINK_PASSCODE_MIN && trimmed.length <= REVIEW_LINK_PASSCODE_MAX) ? null : `Use ${REVIEW_LINK_PASSCODE_MIN} to ${REVIEW_LINK_PASSCODE_MAX} characters.`;
};

/** The create step of the Review links dialog (#741 11b): the ticked Videos, which Versions each shares, expiry, passcode and permissions. The draft is the store's. */
export function ReviewLinkCreateView({ ui, videos }: { ui: ReviewLinksUi; videos: VideoDto[] }) {
  const { store, actions } = ui;
  const state = useReviewLinkState(store);
  const draft = state.create;
  const selected = useMemo(() => videos.filter((video) => state.selection.has(video.id)), [videos, state.selection]);
  const now = useNow();
  const versionsLegend = useId();
  const expiryDay = draft.expiryDay ?? defaultExpiryDay(now);
  const expiry = expiryDayToIso(expiryDay, now);
  const passcodeError = passcodeProblem(draft.passcode);
  const pending = state.pending.has("create");
  const problem = state.problems["create"];
  const chosen = (video: VideoDto): readonly string[] => draft.grants[video.id] ?? [video.currentAssetId];
  const tooMany = selected.length > REVIEW_LINK_MAX_VIDEOS;
  const overLimit = selected.some((video) => chosen(video).length > REVIEW_LINK_MAX_GRANTS_PER_VIDEO);
  const ready = selected.length > 0 && !tooMany && !overLimit && expiry.ok && passcodeError === null && !pending;

  function toggleVersion(video: VideoDto, assetId: string) {
    const current = chosen(video);
    if (!current.includes(assetId) && current.length >= REVIEW_LINK_MAX_GRANTS_PER_VIDEO) return;
    const next = video.versions.map((version) => version.assetId).filter((id) => (id === assetId ? !current.includes(id) : current.includes(id)));
    if (next.length > 0) store.setGrant(video.id, next);
  }

  function submit() {
    if (!ready || !expiry.ok) return;
    const label = draft.label.trim(); const passcode = draft.passcode.trim();
    const body: ReviewLinkCreateInput = {
      videoIds: selected.map((video) => video.id),
      grants: Object.fromEntries(selected.map((video) => [video.id, [...chosen(video)]])),
      expiresAt: expiry.iso,
      ...(label ? { label } : {}),
      ...(passcode ? { passcode } : {}),
      allow: draft.allow,
    };
    const sent = { videoIds: body.videoIds, draft: structuredClone(draft), selectionRevs: store.selectionRevisions(body.videoIds), draftRevs: store.draftRevisions() };
    void store.run("create", () => actions.create(body), (result) => store.showReveal({ url: result.url, linkId: result.link.id, label: result.link.label, origin: "create" }, sent));
  }

  return <ReviewLinkDialogFrame
    header={<DialogHeader>
      <DialogTitle className={DIALOG_TITLE}>Create Review link</DialogTitle>
      <DialogDescription className="text-foreground-secondary">{selected.length === 1 ? "A private link to watch 1 film." : `A private link to watch ${selected.length} films.`} Choose which Versions guests can see.</DialogDescription>
    </DialogHeader>}
    footer={<DialogFooter>
      <Button type="button" variant="secondary" className="min-h-11" onClick={store.closeDialog}>Cancel</Button>
      <Button type="button" variant="primary" className="min-h-11" disabled={!ready} onClick={submit}>{pending ? "Creating…" : "Create link"}</Button>
    </DialogFooter>}
  >
    <div className="grid gap-[var(--space-4)]">
      {tooMany && <Notice tone="caution" role="status">{`A link can hold at most ${REVIEW_LINK_MAX_VIDEOS} films. Untick ${selected.length - REVIEW_LINK_MAX_VIDEOS} to continue.`}</Notice>}
      {selected.length === 0 && <Notice tone="caution" role="status">Tick at least one film on the page first.</Notice>}
      <QuincyField id="review-link-label" label="Label (optional)" placeholder="e.g. Smith family" maxLength={REVIEW_LINK_LABEL_MAX} autoComplete="off" value={draft.label} onChange={(event) => store.patchCreate({ label: event.target.value })} />
      <div className="grid gap-[var(--space-1)]">
        <DateTimeField variant="date" id="review-link-expiry" label="Expires" value={expiryDay} popupAlign="start" positionerClassName={DIALOG_FIELD_LAYER} onApply={(next) => { if (next) store.patchCreate({ expiryDay: next === defaultExpiryDay(now) ? null : next }); }} description="The link stops working at the end of this day." />
        {!expiry.ok && <FieldError>{expiry.message}</FieldError>}
      </div>
      <div className="grid gap-[var(--space-1)]">
        <QuincyField id="review-link-passcode" label="Passcode (optional)" autoComplete="off" spellCheck={false} aria-describedby="review-link-passcode-hint" value={draft.passcode} error={passcodeError} onChange={(event) => store.patchCreate({ passcode: event.target.value })} />
        <FieldDescription id="review-link-passcode-hint">Guests are asked for it before they can watch. Share it separately; it can't be shown again.</FieldDescription>
      </div>
      <ReviewLinkAllowFields value={draft.allow} onChange={(key, next) => store.patchCreate({ allow: { ...draft.allow, [key]: next } })} />
      <div role="group" aria-labelledby={versionsLegend} className="grid gap-[var(--space-3)]">
        <span id={versionsLegend} className={LEGEND}>Versions</span>
        {selected.map((video) => {
          const locked = chosen(video).length === 1;
          const hintId = `review-link-lock-hint-${video.id}`;
          const limitId = `review-link-limit-hint-${video.id}`;
          const full = chosen(video).length >= REVIEW_LINK_MAX_GRANTS_PER_VIDEO;
          return <div key={video.id} role="group" aria-label={video.title} className="grid gap-[var(--space-1)]" data-testid="review-link-create-video">
            <span className="mt-[var(--space-2)] [font:var(--weight-medium)_var(--text-base)/var(--leading-snug)_var(--font-sans)]">{video.title}</span>
            {video.versions.map((version) => {
              const on = chosen(video).includes(version.assetId);
              return <label key={version.assetId} className="flex min-h-11 cursor-pointer items-center gap-[var(--space-3)] [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]">
                <Checkbox data-testid="review-link-version-checkbox" aria-label={`${video.title} v${version.version}`} checked={on} disabled={(on && locked) || (!on && full)} {...(on && locked ? { "aria-describedby": hintId } : !on && full ? { "aria-describedby": limitId } : {})} onChange={() => toggleVersion(video, version.assetId)} />
                <span>{`v${version.version}${version.current ? " (current)" : ""} · ${version.uploadedBy.name} · ${formatVideoDate(version.createdAt)}`}</span>
              </label>;
            })}
            {full && <FieldDescription id={limitId} data-testid="review-link-grant-limit-hint" className="text-foreground-secondary">{GRANT_LIMIT_HINT}</FieldDescription>}
            {locked && <FieldDescription id={hintId} className="text-foreground-secondary">A film needs at least one Version. Remove the film to stop sharing it.</FieldDescription>}
          </div>;
        })}
      </div>
      {problem && <Notice tone="critical" role="alert">{problem.text}</Notice>}
    </div>
  </ReviewLinkDialogFrame>;
}
