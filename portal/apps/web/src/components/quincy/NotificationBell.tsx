import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Bell, CheckCheck } from "lucide-react";
import { apiDelete, apiGet, apiPost } from "../../lib/api";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/reui/popover";
import { Button } from "@/components/reui/button";
import { Badge } from "@/components/reui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/reui/tooltip";
import { cn } from "../../lib/utils";
import { TabStrip } from "./TabStrip";
import { NotificationList } from "./NotificationList";
import {
  dismissFocusTarget,
  filterNotifications,
  groupNotifications,
  type NotificationFilter,
  type NotificationListItem,
} from "../../lib/notification-list";

/**
 * The rail's own notification bell — #112, placed in `NavigationRail`'s header, and #113's own
 * `ShellHeader` bell reuses the same component rather than a second copy.
 *
 * #113 re-anchors the panel to the caller's own chrome surface (the rail or the header), not the
 * bell's trigger, so the panel's edge lines up with that surface's own edge regardless of where
 * inside it the trigger sits.
 *
 * #114 gives the list day buckets, a richer row grid (leading slot, thumbnail, dismiss) and an
 * All/Unread filter — all of it lives in `NotificationList.tsx`, which this file renders as its
 * own `role="tabpanel"` body. This file keeps the data layer (fetch, poll, mark-read/dismiss
 * network calls, the tab's own filter state) and the popover/tab chrome around it.
 *
 * ## Popover, not Menu
 *
 * The panel is base-nova's `reui/popover.tsx` (Base UI `Popover`), not `quincy/menu.tsx` (Base UI
 * `Menu`): a notification list is not a `role="menu"` — no arrow roving, no typeahead, no
 * Home/End — so `Popover.Popup`'s own `role="dialog"`, labelled by `PopoverTitle`, is the accurate
 * semantic. Rows are real `InternalLink`s/`<button>`s in ordinary Tab order (mark-all, the tab
 * strip, then each row's link/dismiss pair); `:focus-visible` is the browser's own pseudo-class
 * here, not a roving `data-highlighted` attribute.
 *
 * `initialFocus` targets the popup itself on every open, so the panel always announces
 * "Notifications, dialog" rather than landing a stray Enter/Space on "Mark all read". `finalFocus`
 * is Base UI's default — Escape and an outside press return focus to the trigger. The
 * dismiss-focus handoff (next row → previous row → the popup) runs in a layout effect keyed on
 * the notification array and the active tab, not a timer: a deferred focus call could land after
 * the list has changed again.
 *
 * Mark all read stays mounted at zero unread rather than unmounting: it goes `aria-disabled="true"`
 * and the click handler returns early, because the `disabled` attribute would drop focus off the
 * currently-focused control where `aria-disabled` does not.
 *
 * A plain click or a Ctrl/Meta click on a row both call `markNotificationRead` and close the
 * panel — `InternalLink`'s own modifier-key bailout (`shouldInterceptInternalLink`) leaves a real
 * browser to open a Ctrl/Meta click in a new tab natively, and the row's `onClick` is not itself
 * modifier-gated. A middle click fires `auxclick`, not `click` — browsers never dispatch `click`
 * for a non-primary button — so it never reaches this handler: the panel stays open and the row
 * stays unread.
 *
 * ## Anchoring (#113)
 *
 * `placement` picks between two fixed shapes, each anchored to `anchorRef` — not the trigger — via
 * `reui/popover.tsx`'s widened `anchor`/`positionMethod` forwarding:
 *
 * - `"rail"`: `side="right" align="start"`, offset out from the rail's own right edge
 *   (`sideOffset={8}`), with `alignOffset` computed from `alignOffsetFor` (below) so the panel's
 *   TOP lines up with the trigger's top rather than the rail's — the rail is much taller than the
 *   trigger, and anchoring the align axis to the rail alone would float the panel up at the rail's
 *   own top edge instead of beside the bell that opened it.
 * - `"header"`: `side="bottom" align="start"`, flush against the header (`sideOffset={0}
 *   alignOffset={0}`), `w-[var(--anchor-width)]` so the panel's own width tracks the header's
 *   rather than a fixed pixel value — the narrow header spans the full viewport width, which a
 *   fixed `420px` would either overflow or leave floating short of.
 *
 * Both anchors are themselves `position: fixed`/sticky surfaces (the rail, `ShellHeader`'s
 * `<header>`), so `positionMethod="fixed"` is shared by both — Base UI's own `"absolute"` default
 * would resolve against the nearest positioned ancestor instead of the viewport and drift out of
 * alignment as the page scrolls.
 *
 * ## Thumbnails key off `placement`, not a media query
 *
 * `"header"` IS the below-772px shell (see `docs/adr/0005…`/`shell-breakpoint.guard.test.ts`) —
 * happy-dom evaluates no `@media` queries at all, and the shell-breakpoint guard forbids a
 * `max-[…]` variant in this file regardless, so `showThumbnails` keys off the `placement` prop
 * JS already threads through rather than a CSS breakpoint of its own.
 */

const NOTIFICATION_POLL_MS = 25_000;

const HEAD = "flex items-center justify-between gap-[var(--space-3)] px-[var(--space-4)] py-[var(--space-3)] " +
  "border-b-[length:var(--border-width-hair)] [border-bottom-style:solid] border-b-border shrink-0";
// `PopoverTitle` renders an `<h2>`; `tokens/base.css`'s unlayered `h1..h4 { font-weight: regular }`
// beats a layered `font-medium` regardless of specificity, so it needs `!`.
const TITLE_WEIGHT = "!font-medium";
const EMPTY = "px-[var(--space-4)] py-[var(--space-5)] text-[length:var(--text-sm)] text-muted-foreground grid gap-[var(--space-3)] justify-items-start";
// `shrink-0` — the trigger sits beside the wordmark/breadcrumb in a flex row, and a long identity
// name or crumb trail must not squeeze the bell's own fixed box. `[&_svg]:size-[19px]` sizes the
// `Bell` icon explicitly rather than relying on lucide's own default, the one source for the
// icon's size (no second `size-*` set on `<Bell>` itself).
const TRIGGER = "relative inline-grid place-items-center size-[34px] shrink-0 text-foreground hover:bg-secondary [&_svg]:size-[19px]";

// 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token. Applied only when the
// caller (`ShellHeader`, below 772px) asks for it via `touchTarget` — the desktop rail keeps the
// trigger's own 34px box. Both axes: `size-`, so tailwind-merge replaces TRIGGER's `size-[34px]`
// rather than leaving the width at 34.
const TOUCH_TARGET = "size-[44px]";

const TABS_ROW = "px-[var(--space-2)] pt-[var(--space-2)] shrink-0";

// Rail placement is a fixed 420px, wide enough to hold a full notification row without wrapping
// its body text; header placement instead tracks the header's own width (`w-[var(--anchor-width)]`
// below, set per-render in the component body) since the narrow header spans the full viewport and
// a fixed pixel width would either overflow it or float short. A plain overflow list, not
// `scroll-area`: these rows are simple enough that native keyboard scrolling needs no extra
// registry item.
const PANEL = "max-h-[min(520px,var(--available-height))] gap-0 p-0 flex-col";
// The two fixed shapes the file header describes, as data. `alignOffset` is not here: the rail's
// is a callback over live refs (see `railAlignOffset` in the component), the header's is 0.
// `thumbnails` records the same "header is the narrow shell" fact `showThumbnails` reads below,
// named here so the two fixed shapes stay a single source rather than a second boolean expression
// drifting out of sync with `side`/`width`.
const PLACEMENT = {
  rail: { side: "right", sideOffset: 8, collisionPadding: 8, width: "w-[420px]", thumbnails: true },
  header: { side: "bottom", sideOffset: 0, collisionPadding: { top: 0, left: 0, right: 0, bottom: 8 }, width: "w-[var(--anchor-width)]", thumbnails: false },
} as const;
// `min-h-0 flex-1` lets the scrolling body shrink inside the popup's own `flex-col`; the tabpanel
// IS the scrolling container (TabStrip's own convention — see Admin.tsx around its tabpanel ids).
const LIST = "min-h-0 flex-1 overflow-y-auto overscroll-contain";

/**
 * `trigger.top - anchor.top`, floored at 0 — the distance to shift the panel's start-aligned
 * position down so it lines up with the bell that opened it rather than the top of a much taller
 * anchor (the rail). Exported pure so it can be unit-tested without mounting a Positioner; a
 * missing ref (either side) falls back to 0 at the call site, not here — this function only ever
 * sees two numbers.
 */
export function alignOffsetFor(triggerTop: number, anchorTop: number): number {
  return Math.max(0, triggerTop - anchorTop);
}

export type NotificationBellProps = {
  /** Poll interval override, for tests. */
  poll?: number;
  /** True in the narrow header, where every control must clear 44px. */
  touchTarget?: boolean;
  /**
   * `"rail"` (`NavigationRail`'s own header) anchors the panel to the rail's right edge, offset
   * down to the trigger; `"header"` (`ShellHeader`'s narrow bell) anchors flush under the header,
   * spanning its width. Required — no silent fallback, since the two shapes are not interchangeable.
   */
  placement: "rail" | "header";
  /** The rail or header element the panel is anchored to — not the trigger. See the file header. */
  anchorRef: RefObject<HTMLElement | null>;
};

type NotificationsResponse = { notifications: NotificationListItem[]; unreadCount: number };

export function NotificationBell({ poll = NOTIFICATION_POLL_MS, touchTarget = false, placement, anchorRef }: NotificationBellProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const idPrefix = useId();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationListItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [tab, setTab] = useState<NotificationFilter>("all");
  // Captured rather than read live, so every row in one render agrees on "now" — refreshed on
  // open and on each poll response, never on a render-by-render basis.
  const [now, setNow] = useState(() => Date.now());
  const notificationsPopupRef = useRef<HTMLDivElement | null>(null);
  // Set only by `dismissNotification`, consumed by the layout effect below — never a timer: a
  // deferred focus call could land after the list has changed again.
  const pendingDismissFocusRef = useRef<string | "panel" | null>(null);

  useEffect(() => {
    let active = true;
    const loadNotifications = async () => {
      try {
        const response = await apiGet<NotificationsResponse>("/api/notifications?limit=25");
        if (active) { setNotifications(response.notifications); setUnreadCount(response.unreadCount); setNow(Date.now()); }
      } catch { /* The bell is best effort and should not disrupt the app shell. */ }
    };
    void loadNotifications();
    const timer = window.setInterval(() => void loadNotifications(), poll);
    return () => { active = false; window.clearInterval(timer); };
  }, [poll]);

  const filtered = filterNotifications(notifications, tab);
  const buckets = groupNotifications(filtered, now);
  const visible = buckets.flatMap((bucket) => bucket.notifications);
  const showThumbnails = PLACEMENT[placement].thumbnails;

  useLayoutEffect(() => {
    const target = pendingDismissFocusRef.current;
    if (!target) return;
    pendingDismissFocusRef.current = null;
    const panel = notificationsPopupRef.current;
    if (target === "panel") { panel?.focus(); return; }
    const dismissButton = panel?.querySelector<HTMLButtonElement>(`[data-notification-dismiss="${CSS.escape(target)}"]`);
    // The tracked row may no longer be mounted (a poll dropped it, or the tab changed underneath
    // the pending handoff) — the panel itself is the fallback rather than leaving focus stranded.
    if (dismissButton) dismissButton.focus(); else panel?.focus();
  }, [notifications, tab]);

  function handleOpenChange(open: boolean) {
    setNotificationsOpen(open);
    if (open) setNow(Date.now());
    else pendingDismissFocusRef.current = null;
  }

  function selectTab(next: NotificationFilter) {
    // A pending dismiss handoff from the tab just left no longer refers to a row this tab shows.
    pendingDismissFocusRef.current = null;
    setTab(next);
  }

  function focusAllTabAndShowAll() {
    const targetId = `${idPrefix}-tab-all`;
    notificationsPopupRef.current?.querySelector<HTMLButtonElement>(`[id="${CSS.escape(targetId)}"]`)?.focus();
    selectTab("all");
  }

  async function markNotificationRead(notification: NotificationListItem) {
    if (notification.readAt) return;
    setNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item));
    setUnreadCount((current) => Math.max(0, current - 1));
    try { await apiPost("/api/notifications/" + encodeURIComponent(notification.id) + "/read", {}); } catch { /* The next poll restores server state. */ }
  }

  async function markAllNotificationsRead() {
    setNotifications((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
    setUnreadCount(0);
    try { await apiPost("/api/notifications/read-all", {}); } catch { /* The next poll restores server state. */ }
  }

  function handleMarkAllClick() {
    // `aria-disabled`, not the `disabled` attribute, keeps focus on the control while this is a
    // no-op at zero unread.
    if (unreadCount === 0) return;
    void markAllNotificationsRead();
  }

  function activateRow(notification: NotificationListItem) {
    void markNotificationRead(notification);
    setNotificationsOpen(false);
  }

  async function dismissNotification(notification: NotificationListItem) {
    pendingDismissFocusRef.current = dismissFocusTarget(visible, notification.id) ?? "panel";
    setNotifications((current) => current.filter((item) => item.id !== notification.id));
    if (!notification.readAt) setUnreadCount((current) => Math.max(0, current - 1));
    try { await apiDelete("/api/notifications/" + encodeURIComponent(notification.id)); } catch { /* The next poll restores server state. */ }
  }

  const cappedCount = unreadCount > 99 ? "99+" : String(unreadCount);

  // The rail's own align axis — see the file header's "Anchoring" section. A plain function, not
  // `useCallback`: `alignOffset` is read once per Positioner measurement, not on every render, so
  // memoising it would buy nothing.
  function railAlignOffset(): number {
    const trigger = triggerRef.current;
    const anchor = anchorRef.current;
    if (!trigger || !anchor) return 0;
    return alignOffsetFor(trigger.getBoundingClientRect().top, anchor.getBoundingClientRect().top);
  }

  return (
    <div className="relative" data-testid="rail-notifications">
      <Popover open={notificationsOpen} onOpenChange={handleOpenChange} modal={false}>
        <PopoverTrigger
          ref={triggerRef}
          className={cn(TRIGGER, touchTarget && TOUCH_TARGET)}
          aria-label={unreadCount ? `${unreadCount} unread notifications` : "Notifications"}
          data-testid="rail-notification-trigger"
        >
          {/* `display: contents` — a real DOM node to carry the `data-touch-target` test seam
              without changing the trigger's own layout box. */}
          <span className="contents" data-touch-target={touchTarget ? true : undefined}>
            <Bell aria-hidden="true" />
            <span className="sr-only">Notifications</span>
            {unreadCount > 0 && (
              <span
                className={cn(
                  "absolute top-0 right-[-3px] min-w-[16px] h-[16px] px-1 rounded-[var(--radius-pill)]",
                  "text-center leading-[16px] whitespace-nowrap tabular-nums",
                  "bg-destructive !text-destructive-foreground text-[length:var(--text-2xs)]",
                )}
                aria-label={`${unreadCount} unread`}
                data-testid="rail-notification-badge"
              >
                {cappedCount}
              </span>
            )}
          </span>
        </PopoverTrigger>
        <PopoverContent
          ref={notificationsPopupRef}
          data-testid="rail-notifications-panel"
          initialFocus={notificationsPopupRef}
          anchor={anchorRef}
          positionMethod="fixed"
          side={PLACEMENT[placement].side}
          align="start"
          sideOffset={PLACEMENT[placement].sideOffset}
          alignOffset={placement === "rail" ? railAlignOffset : 0}
          collisionPadding={PLACEMENT[placement].collisionPadding}
          collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
          className={cn(PANEL, PLACEMENT[placement].width)}
        >
          <div className={HEAD}>
            <PopoverTitle className={TITLE_WEIGHT}>Notifications</PopoverTitle>
            {unreadCount > 0 && (
              <Badge size="xs" radius="full" aria-label={`${unreadCount} unread`} data-testid="rail-notifications-count">
                {cappedCount}
              </Badge>
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className={cn("ml-auto", touchTarget && TOUCH_TARGET)}
                    aria-label="Mark all read"
                    aria-disabled={unreadCount === 0 ? "true" : undefined}
                    data-testid="rail-mark-all-read"
                    onClick={handleMarkAllClick}
                  />
                }
              >
                <CheckCheck aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>Mark all read</TooltipContent>
            </Tooltip>
          </div>

          <TabStrip
            idPrefix={idPrefix}
            label="Filter notifications"
            value={tab}
            onValueChange={(next) => selectTab(next as NotificationFilter)}
            className={TABS_ROW}
            items={[
              // All has no count — the list is capped at 25, so its length is not a total.
              { value: "all", label: "All" },
              // The same number the trigger/header badge shows, uncapped: `TabItem.count` is a
              // plain number, and the "99+" cap is a display-only affordance of the badge glyph.
              { value: "unread", label: "Unread", count: unreadCount },
            ]}
          />

          <div
            role="tabpanel"
            id={`${idPrefix}-panel-${tab}`}
            aria-labelledby={`${idPrefix}-tab-${tab}`}
            tabIndex={0}
            className={LIST}
          >
            {filtered.length === 0 ? (
              tab === "all" ? (
                <div className={EMPTY} data-testid="rail-notifications-empty" data-notification-empty="all">
                  <span>No notifications.</span>
                </div>
              ) : (
                <div className={EMPTY} data-testid="rail-notifications-empty" data-notification-empty="unread">
                  <span>You’re all caught up.</span>
                  <Button type="button" variant="ghost" size="sm" data-testid="rail-notifications-show-all" onClick={focusAllTabAndShowAll}>
                    Show all notifications
                  </Button>
                  {unreadCount > 0 && <span>Older unread notifications may be outside this recent list.</span>}
                </div>
              )
            ) : (
              <NotificationList
                buckets={buckets}
                now={now}
                showThumbnails={showThumbnails}
                onActivate={activateRow}
                onDismiss={(notification) => void dismissNotification(notification)}
              />
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
