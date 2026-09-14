import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Bell, CheckCheck } from "lucide-react";
import { apiDelete, apiGet, apiPost } from "../../lib/api";
import { InternalLink } from "../InternalLink";
import { projectNotificationRoute, staffPathFor } from "@quincy/shared";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/reui/popover";
import { Button } from "@/components/reui/button";
import { Badge } from "@/components/reui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/reui/tooltip";
import { cn } from "../../lib/utils";

/**
 * The rail's own notification bell — #112, placed in `NavigationRail`'s header, and #113's own
 * `ShellHeader` bell reuses the same component rather than a second copy.
 *
 * #113 re-anchors the panel to the caller's own chrome surface (the rail or the header), not the
 * bell's trigger, so the panel's edge lines up with that surface's own edge regardless of where
 * inside it the trigger sits. Day buckets, thumbnails and a richer row layout are #114 — neither
 * ticket's scope is closed by this file.
 *
 * ## Popover, not Menu
 *
 * The panel is base-nova's `reui/popover.tsx` (Base UI `Popover`), not `quincy/menu.tsx` (Base UI
 * `Menu`): a notification list is not a `role="menu"` — no arrow roving, no typeahead, no
 * Home/End — so `Popover.Popup`'s own `role="dialog"`, labelled by `PopoverTitle`, is the accurate
 * semantic. Rows are real `InternalLink`s/`<button>`s in ordinary Tab order (mark-all, then each
 * row's link/dismiss pair); `:focus-visible` is the browser's own pseudo-class here, not a roving
 * `data-highlighted` attribute, so `HIGHLIGHT_STATE` below carries no `data-highlighted:` variant.
 *
 * `initialFocus` targets the popup itself on every open, so the panel always announces
 * "Notifications, dialog" rather than landing a stray Enter/Space on "Mark all read". `finalFocus`
 * is Base UI's default — Escape and an outside press return focus to the trigger. The
 * dismiss-focus handoff (next row → previous row → the popup) runs in a layout effect keyed on
 * the notification array, not a timer: a deferred focus call could land after the list has
 * changed again.
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
 */

type NotificationItem = {
  id: string;
  projectId: string | null;
  type: string;
  title: string;
  body: string | null;
  readAt: string | null;
  createdAt: string;
};
type NotificationsResponse = { notifications: NotificationItem[]; unreadCount: number };

const NOTIFICATION_POLL_MS = 25_000;

const ROW = "grid grid-cols-[minmax(0,1fr)_auto] border-b-[length:var(--border-width-hair)] " +
  "[border-bottom-style:solid] border-b-border bg-transparent hover:bg-secondary " +
  "[border-left-style:solid] border-l-[length:var(--border-width-rule)] border-l-transparent " +
  "data-[unread]:border-l-primary";
// `data-highlighted:border-l-primary` is dropped — nothing can set that attribute on a plain
// `<a>`/`<button>` row; `:focus-visible` is the browser's own pseudo-class here, not a roving
// Base UI attribute. The leading border itself stays, transparent, to reserve the space it
// occupies when painted (`ROW`'s own unread indicator), so rows don't shift width without it.
const HIGHLIGHT_STATE = "border-l-[length:var(--border-width-bold)] border-l-transparent " +
  "active:bg-surface-sunken outline-none " +
  "focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)] " +
  "focus-visible:!outline-solid " +
  "focus-visible:!outline-ring focus-visible:!outline-offset-[-2px]";
const ITEM = cn(
  "grid gap-1 py-[var(--space-3)] pr-0 pl-[var(--space-4)] border-0 bg-transparent",
  "text-foreground text-left cursor-pointer no-underline hover:bg-secondary",
  HIGHLIGHT_STATE,
);
const ITEM_TITLE = "text-[length:var(--text-sm)] font-normal !text-foreground";
const ITEM_BODY = "text-[length:var(--text-xs)] leading-[var(--leading-normal)] text-foreground-secondary";
const ITEM_META = "text-[length:var(--text-2xs)] text-muted-foreground";
const DISMISS = cn(
  "size-[44px] border-0 bg-transparent text-foreground-secondary cursor-pointer",
  "[font:var(--weight-regular)_var(--text-md)/1_var(--font-mono)] leading-none hover:!text-foreground hover:bg-secondary",
  /* 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token */
  HIGHLIGHT_STATE,
);
const HEAD = "flex items-center justify-between gap-[var(--space-3)] px-[var(--space-4)] py-[var(--space-3)] " +
  "border-b-[length:var(--border-width-hair)] [border-bottom-style:solid] border-b-border shrink-0";
// `PopoverTitle` renders an `<h2>`; `tokens/base.css`'s unlayered `h1..h4 { font-weight: regular }`
// beats a layered `font-medium` regardless of specificity, so it needs `!`.
const TITLE_WEIGHT = "!font-medium";
const EMPTY = "px-[var(--space-4)] py-[var(--space-5)] text-[length:var(--text-sm)] text-muted-foreground";
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

// Rail placement is a fixed 420px, wide enough to hold a full notification row without wrapping
// its body text; header placement instead tracks the header's own width (`w-[var(--anchor-width)]`
// below, set per-render in the component body) since the narrow header spans the full viewport and
// a fixed pixel width would either overflow it or float short. A plain overflow list, not
// `scroll-area`: these rows are simple enough that native keyboard scrolling needs no extra
// registry item.
const PANEL = "max-h-[min(520px,var(--available-height))] gap-0 p-0 flex-col";
const RAIL_PANEL_WIDTH = "w-[420px]";
const HEADER_PANEL_WIDTH = "w-[var(--anchor-width)]";
// `list-none` removes the `<ul>`'s marker, which also drops its implicit list semantics under
// Safari/VoiceOver — the `role="list"` on the element itself restores them.
const LIST = "min-h-0 flex-1 overflow-y-auto overscroll-contain m-0 p-0 list-none";

function NotificationRowContent({ notification }: { notification: NotificationItem }) {
  return (
    <>
      <strong className={ITEM_TITLE}>{notification.title}</strong>
      {notification.body && <span className={ITEM_BODY}>{notification.body}</span>}
      <small className={ITEM_META}>{new Date(notification.createdAt).toLocaleString()}</small>
    </>
  );
}

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

export function NotificationBell({ poll = NOTIFICATION_POLL_MS, touchTarget = false, placement, anchorRef }: NotificationBellProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const notificationsPopupRef = useRef<HTMLDivElement | null>(null);
  // Set only by `dismissNotification`, consumed by the layout effect below — never a timer: a
  // deferred focus call could land after the list has changed again.
  const pendingDismissFocusRef = useRef<string | "panel" | null>(null);

  useEffect(() => {
    let active = true;
    const loadNotifications = async () => {
      try {
        const response = await apiGet<NotificationsResponse>("/api/notifications?limit=25");
        if (active) { setNotifications(response.notifications); setUnreadCount(response.unreadCount); }
      } catch { /* The bell is best effort and should not disrupt the app shell. */ }
    };
    void loadNotifications();
    const timer = window.setInterval(() => void loadNotifications(), poll);
    return () => { active = false; window.clearInterval(timer); };
  }, [poll]);

  useLayoutEffect(() => {
    const target = pendingDismissFocusRef.current;
    if (!target) return;
    pendingDismissFocusRef.current = null;
    const panel = notificationsPopupRef.current;
    if (target === "panel") { panel?.focus(); return; }
    panel?.querySelector<HTMLButtonElement>(`[data-notification-dismiss="${CSS.escape(target)}"]`)?.focus();
  }, [notifications]);

  async function markNotificationRead(notification: NotificationItem) {
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

  function activateRow(notification: NotificationItem) {
    void markNotificationRead(notification);
    setNotificationsOpen(false);
  }

  async function dismissNotification(notification: NotificationItem) {
    const notificationIndex = notifications.findIndex((item) => item.id === notification.id);
    const focusTargetId = notificationIndex < 0 ? null : notifications[notificationIndex + 1]?.id ?? notifications[notificationIndex - 1]?.id ?? null;
    pendingDismissFocusRef.current = focusTargetId ?? "panel";
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
      <Popover open={notificationsOpen} onOpenChange={setNotificationsOpen} modal={false}>
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
          side={placement === "rail" ? "right" : "bottom"}
          align="start"
          sideOffset={placement === "rail" ? 8 : 0}
          alignOffset={placement === "rail" ? railAlignOffset : 0}
          collisionPadding={placement === "rail" ? 8 : { top: 0, left: 0, right: 0, bottom: 8 }}
          collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
          className={cn(PANEL, placement === "rail" ? RAIL_PANEL_WIDTH : HEADER_PANEL_WIDTH)}
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
          {notifications.length === 0 ? (
            <div className={EMPTY} role="none" data-testid="rail-notifications-empty">You’re all caught up.</div>
          ) : (
            <ul className={LIST} role="list">
              {notifications.map((notification) => {
                const route = projectNotificationRoute(notification.projectId, notification.type);
                return (
                  <li key={notification.id} className={ROW} data-unread={notification.readAt ? undefined : ""}>
                    {route?.kind === "project" ? (
                      <InternalLink
                        to={staffPathFor(route)}
                        className={ITEM}
                        onClick={() => activateRow(notification)}
                        data-testid="rail-notification-item"
                        data-notification-route="project"
                      >
                        <NotificationRowContent notification={notification} />
                      </InternalLink>
                    ) : (
                      <button
                        type="button"
                        className={ITEM}
                        onClick={() => activateRow(notification)}
                        data-testid="rail-notification-item"
                        data-notification-route="none"
                      >
                        <NotificationRowContent notification={notification} />
                      </button>
                    )}
                    <button
                      type="button"
                      className={DISMISS}
                      aria-label={`Dismiss notification: ${notification.title}`}
                      data-notification-dismiss={notification.id}
                      onClick={() => void dismissNotification(notification)}
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
