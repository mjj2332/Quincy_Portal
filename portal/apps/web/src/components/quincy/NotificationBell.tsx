import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bell, CheckCheck } from "lucide-react";
import { apiDelete, apiGet, apiPost } from "../../lib/api";
import { InternalLink } from "../InternalLink";
import { projectNotificationRoute, staffPathFor } from "@quincy/shared";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/reui/popover";
import { Button } from "@/components/reui/button";
import { Badge } from "@/components/reui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/reui/tooltip";
import { cn } from "../../lib/utils";
import { NOTIFICATION_POLL_MS } from "../Topbar";

/**
 * The rail's own notification bell — #112, placed in `NavigationRail`'s header.
 *
 * ## Copied, not extracted
 *
 * This is a COPY of `components/Topbar.tsx`'s bell (poll, trigger, unread badge with its own
 * `99+` cap, and the panel's read/dismiss/mark-all behaviour), with its own `rail-notification-*`
 * test ids. It is copied rather than shared for the same reason `NavigationRail` duplicates the
 * Topbar's sign-out handling (see that file's header comment): the Topbar ships today and this
 * does not, so the two must be free to diverge until the cutover ticket removes one of them.
 * `components/Topbar.tsx` itself is unchanged by this file — the only thing imported from it is
 * `NOTIFICATION_POLL_MS`, which it already exports.
 *
 * #113 re-anchors this panel (420px, wider than the Topbar's 360px, to match the rail's own
 * width budget), ports the Topbar's full notification parity suite across, and deletes the
 * Topbar original. Day buckets, thumbnails and a richer row layout are #114. Neither ticket's
 * scope is closed by this file.
 *
 * ## Where the paint differs from the Topbar's copy
 *
 * The trigger and panel classes below are copied verbatim from `Topbar.tsx` except for the
 * `touchTarget` addition, which the Topbar has no equivalent of — the Topbar's own mobile touch
 * target comes from a `max-[721px]:size-[44px]` breakpoint, which has no meaning in a rail that
 * never resizes by media query.
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
 * `align` (below) differs by caller: the rail header bell keeps the default `"start"`, which
 * keeps the panel over the content rather than shifted off the rail's own left edge; `ShellHeader`
 * passes `"end"` for its narrow, right-aligned bell. `side="bottom"` and the collision settings
 * are shared by both — they sit at the top of the screen, so flipping to a side with even less
 * room never helps.
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
const TRIGGER = "relative inline-grid place-items-center size-[34px] text-foreground hover:bg-secondary";

// 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token. Applied only when the
// caller (`ShellHeader`, below 772px) asks for it via `touchTarget` — the desktop 250px/48px rail
// keeps the trigger's own 34px box, same as the Topbar's default. Both axes: `size-`, so
// tailwind-merge replaces TRIGGER's `size-[34px]` rather than leaving the width at 34.
const TOUCH_TARGET = "size-[44px]";

// Today's width/height bounds, unchanged from the earlier Menu-based panel. #113 owns the final
// 420px anchor. A plain overflow list, not `scroll-area`: these rows are simple enough that
// native keyboard scrolling needs no extra registry item.
const PANEL = "w-[min(360px,calc(100vw-var(--space-5)))] max-h-[min(520px,var(--available-height))] " +
  "gap-0 p-0 flex-col";
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

export type NotificationBellProps = {
  /** Poll interval override, for tests — mirrors the Topbar's `notificationPollMs`. */
  poll?: number;
  /** True in the narrow header, where every control must clear 44px. */
  touchTarget?: boolean;
  /** `ShellHeader`'s narrow bell passes `"end"`; every other call site keeps the default `"start"`. */
  align?: "start" | "end";
};

export function NotificationBell({ poll = NOTIFICATION_POLL_MS, touchTarget = false, align = "start" }: NotificationBellProps) {
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

  return (
    <div className="relative" data-testid="rail-notifications">
      <Popover open={notificationsOpen} onOpenChange={setNotificationsOpen} modal={false}>
        <PopoverTrigger
          className={cn(TRIGGER, "[&_svg]:size-[19px]", touchTarget && TOUCH_TARGET)}
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
                className="bg-destructive !text-destructive-foreground text-[length:var(--text-2xs)]"
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
          side="bottom"
          align={align}
          sideOffset={8}
          collisionPadding={8}
          collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
          className={PANEL}
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
