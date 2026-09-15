import { useId } from "react";
import { SYDNEY_TIME_ZONE, isCautionNotificationType, projectNotificationRoute, staffPathFor } from "@quincy/shared";
import { InternalLink } from "../InternalLink";
import { LazyImage } from "../LazyImage";
import { formatNotificationTimestamp, type NotificationBucket, type NotificationListItem } from "../../lib/notification-list";
import { Eyebrow } from "./Eyebrow";
import { cn } from "../../lib/utils";
import { Avatar, AvatarFallback } from "../reui/avatar";
import { initials } from "../../lib/initials";

/**
 * Extracted from `NotificationBell.tsx` (#114) — the day-bucketed list, its row grid, thumbnails
 * and dismiss control, with no popover/tab/poll machinery of its own. `NotificationBell` owns
 * data (fetch, poll, mark-read/dismiss network calls, tab filter state) and renders this as its
 * `role="tabpanel"` body; this file owns markup only, so it can be unit-tested with plain props.
 *
 * ## Row focus ring
 *
 * The visible `:focus-visible` ring lives on the `<li>` (`has-[[data-notification-title]:focus-
 * visible]:…`), not on the title control itself (`!outline-none` there). The title link is
 * stretched over the whole row (`after:absolute after:inset-0`), so its own ring would draw a box
 * the size of the row anyway; keying the `has-` selector to the title's `data-notification-title`
 * attribute, rather than any focusable descendant, stops the dismiss button's focus from ALSO
 * lighting the row-wide ring on top of its own.
 *
 * ## Thumbnail aria-hiding
 *
 * `LazyImage`'s own loading/failed placeholders are `role="status"` live regions — appropriate
 * for a single hero image, wrong for up to 25 decorative row thumbnails firing at once on open.
 * The wrapper span is `aria-hidden="true"` for exactly that reason; `alt=""` on `LazyImage` itself
 * keeps a stray `<img>` (the loaded case) out of the accessibility tree the same way.
 */

const GRID_WITH_THUMB = "grid-cols-[28px_minmax(0,1fr)_64px_44px]";
const GRID_NO_THUMB = "grid-cols-[28px_minmax(0,1fr)_44px]";

const ROW_FOCUS_RING =
  'has-[[data-notification-title]:focus-visible]:outline ' +
  'has-[[data-notification-title]:focus-visible]:outline-[length:var(--border-width-bold)] ' +
  'has-[[data-notification-title]:focus-visible]:outline-solid ' +
  'has-[[data-notification-title]:focus-visible]:outline-ring ' +
  'has-[[data-notification-title]:focus-visible]:outline-offset-[-2px]';

const ROW = cn(
  "relative grid gap-[10px] py-[var(--space-3)] pr-0",
  // 13px — reserves room for the row's own 3px unread rule plus a visual gap, so the leading
  // 28px slot does not crowd it; not a spacing token.
  "pl-[13px]",
  "border-b-[length:var(--border-width-hair)] [border-bottom-style:solid] border-b-border",
  "[border-left-style:solid] border-l-[length:var(--border-width-rule)] border-l-transparent",
  "data-[unread]:border-l-primary hover:bg-secondary",
  ROW_FOCUS_RING,
);

// `!outline-none`, not the plain utility — `tokens/base.css`'s unlayered `:focus-visible { outline:
// … }` (imported outside any cascade layer at `index.css`) beats an ordinary Tailwind utility
// regardless of specificity, so the title link/button's OWN outline needs `!` to actually
// disappear; the ring itself is drawn by the row's `has-[…]:` selector below instead.
const ITEM_TITLE_BASE = "text-[length:var(--text-sm)] font-normal !outline-none text-left cursor-pointer no-underline bg-transparent border-0 p-0";
// `line-clamp-[2]` — the arbitrary-value form, not the plain `line-clamp-2` scale utility: the
// test-seam guard's `isUtilityClass` recognises punctuation (`[`/`]`) as a Tailwind utility but
// does not (yet) list the `line-clamp-` family among its bare-scale prefixes, so the plain form
// would read as a Quincy BEM name to guard C and fail it. Same computed style either way.
const ITEM_BODY = "text-[length:var(--text-xs)] leading-[var(--leading-normal)] text-foreground-secondary line-clamp-[2]";
const ITEM_META = "text-[length:var(--text-2xs)] text-muted-foreground";
const DISMISS = cn(
  "relative z-[1] size-[44px] border-0 bg-transparent text-foreground-secondary cursor-pointer",
  "[font:var(--weight-regular)_var(--text-md)/1_var(--font-mono)] leading-none hover:!text-foreground hover:bg-secondary",
  /* 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token */
  "outline-none focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)]",
  "focus-visible:!outline-solid focus-visible:!outline-ring focus-visible:!outline-offset-[-2px]",
);

// Sydney absolute date-time for the row's `<time title>` — a fuller rendering than the relative
// `formatNotificationTimestamp` text, read the same `formatToParts` way (see `notification-list.ts`).
const ABSOLUTE_TIME_FORMATTER = new Intl.DateTimeFormat("en-AU", {
  timeZone: SYDNEY_TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

export type NotificationRowProps = {
  notification: NotificationListItem;
  now: number;
  showThumbnail: boolean;
  onActivate: (notification: NotificationListItem) => void;
  onDismiss: (notification: NotificationListItem) => void;
};

export function NotificationRow({ notification, now, showThumbnail, onActivate, onDismiss }: NotificationRowProps) {
  const { id, projectId, type, title, body, readAt, createdAt, projectStreet, coverAssetId, actor, assetId } = notification;
  const route = projectNotificationRoute(projectId, type);
  const thumbnailAssetId = assetId ?? coverAssetId;
  const caution = isCautionNotificationType(type);
  const titleClassName = cn(ITEM_TITLE_BASE, caution ? "!text-warning" : "!text-foreground");

  return (
    <li
      data-testid="rail-notification-row"
      data-unread={readAt ? undefined : ""}
      data-notification-tone={caution ? "caution" : undefined}
      className={cn(ROW, showThumbnail ? GRID_WITH_THUMB : GRID_NO_THUMB)}
    >
      {/* Leading slot — #116. When the row has a resolved actor, an initials avatar; otherwise a
          reserved, empty 28px box (a system row, or an actor the resolver could not name). Always
          the first child, and always the same 28px box in both branches, so every row reserves the
          same column whether or not it is filled. `aria-hidden` on the whole slot: the actor's
          name is already spoken as part of the row's title/body text, so the avatar's initials
          would only repeat it. */}
      {actor ? (
        <span data-notification-leading data-notification-actor aria-hidden="true" className="size-[28px]">
          <Avatar className="size-[28px]">
            <AvatarFallback
              className={cn(
                "bg-[var(--ink-900)] text-[color:var(--paper-050)]",
                "text-[length:12px] leading-[1.2] font-[family-name:var(--font-sans)] font-[var(--weight-regular)] tracking-[0.02em]",
              )}
            >
              {initials(actor.name)}
            </AvatarFallback>
          </Avatar>
        </span>
      ) : (
        <span data-notification-leading aria-hidden="true" className="size-[28px]" />
      )}
      <div className="grid gap-1 min-w-0">
        {route?.kind === "project" ? (
          <InternalLink
            to={staffPathFor(route)}
            className={cn(titleClassName, "after:absolute after:inset-0")}
            onClick={() => onActivate(notification)}
            data-testid="rail-notification-item"
            data-notification-title=""
            data-notification-route="project"
          >
            {title}
          </InternalLink>
        ) : (
          <button
            type="button"
            className={cn(titleClassName, "after:absolute after:inset-0")}
            onClick={() => onActivate(notification)}
            data-testid="rail-notification-item"
            data-notification-title=""
            data-notification-route="none"
          >
            {title}
          </button>
        )}
        {/* Body and meta are SIBLINGS of the link/button above, not children of it — inside the
            link they would be read as part of its accessible name; outside, assistive tech reads
            them as ordinary row content while the link's own name stays just the title. */}
        {body && <span data-notification-body className={ITEM_BODY}>{body}</span>}
        <small data-notification-meta className={ITEM_META}>
          {projectStreet && <>{projectStreet}{" · "}</>}
          <time dateTime={createdAt} title={ABSOLUTE_TIME_FORMATTER.format(new Date(createdAt))}>
            {formatNotificationTimestamp(createdAt, now)}
          </time>
        </small>
      </div>
      {showThumbnail && (
        <span data-notification-thumb aria-hidden="true" className="w-[64px] h-[44px] bg-surface-sunken overflow-hidden">
          {thumbnailAssetId ? (
            <LazyImage preload="background" assetId={thumbnailAssetId} alt="" className="size-full object-cover" />
          ) : (
            /* A project with no RAW frame yet has no cover to resolve to — a still, sunken swatch, not
               a `Skeleton`: a pulse reads as "loading", and nothing is coming. */
            <span data-testid="rail-notification-thumb-placeholder" className="block size-full bg-surface-sunken" />
          )}
        </span>
      )}
      <button
        type="button"
        className={DISMISS}
        aria-label={`Dismiss notification: ${title}`}
        data-notification-dismiss={id}
        onClick={() => onDismiss(notification)}
      >
        ×
      </button>
    </li>
  );
}

export type NotificationListProps = {
  buckets: readonly NotificationBucket[];
  now: number;
  showThumbnails: boolean;
  onActivate: (notification: NotificationListItem) => void;
  onDismiss: (notification: NotificationListItem) => void;
};

// `list-none` removes the `<ul>`'s marker, which also drops its implicit list semantics under
// Safari/VoiceOver — the `role="list"` on the element itself restores them.
const BUCKET_LIST = "m-0 p-0 list-none";
// Sunken band, hairline top and bottom — deliberately NOT `sticky`: a bucket heading that stuck
// while its own rows scrolled past would visually detach from the day it labels.
const BUCKET_HEAD = "bg-secondary [border-top-style:solid] [border-bottom-style:solid] border-t-[length:var(--border-width-hair)] border-b-[length:var(--border-width-hair)] border-t-border border-b-border px-[var(--space-4)] py-[var(--space-2)]";

export function NotificationList({ buckets, now, showThumbnails, onActivate, onDismiss }: NotificationListProps) {
  const headingIdPrefix = useId();
  return (
    <>
      {buckets.map((bucket) => {
        const headingId = `${headingIdPrefix}-bucket-${bucket.key}`;
        return (
          <section key={bucket.key} data-notification-bucket={bucket.key} aria-labelledby={headingId}>
            <h3 id={headingId} className={BUCKET_HEAD}>
              <Eyebrow>{bucket.label}</Eyebrow>
            </h3>
            <ul className={BUCKET_LIST} role="list">
              {bucket.notifications.map((notification) => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  now={now}
                  showThumbnail={showThumbnails}
                  onActivate={onActivate}
                  onDismiss={onDismiss}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
