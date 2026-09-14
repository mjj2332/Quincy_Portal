import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { apiDelete, apiGet, apiPost } from "../../lib/api";
import { InternalLink } from "../InternalLink";
import { projectNotificationRoute, staffPathFor } from "@quincy/shared";
import { Menu } from "./menu";
import { Button } from "./Button";
import { cn } from "../../lib/utils";
import { NOTIFICATION_POLL_MS } from "../Topbar";

/**
 * The rail's own notification bell — #112, placed in `NavigationRail`'s header.
 *
 * ## Copied, not extracted
 *
 * This is a COPY of `components/Topbar.tsx`'s bell (poll, trigger, unread badge with its `99+`
 * cap, and the panel's read/dismiss/mark-all behaviour), with its own `rail-notification-*` test
 * ids. It is copied rather than shared for the same reason `NavigationRail` duplicates the
 * Topbar's sign-out handling (see that file's header comment): the Topbar ships today and this
 * does not, so the two must be free to diverge until the cutover ticket removes one of them.
 * `components/Topbar.tsx` itself is unchanged by this file — the only thing imported from it is
 * `NOTIFICATION_POLL_MS`, which it already exports.
 *
 * #113 re-anchors this panel (420px, wider than the Topbar's 360px, to match the rail's own
 * width budget), ports the Topbar's full notification parity suite across, and deletes the
 * Topbar original. This file therefore does NOT carry that full parity suite — only the four
 * cases #112 actually needs (see `NotificationBell.dom.test.tsx`). Do not treat its absence here
 * as a gap to close in this ticket.
 *
 * ## Where the paint differs from the Topbar's copy
 *
 * The trigger and panel classes below are copied verbatim from `Topbar.tsx` except for the
 * `touchTarget` addition (below), which the Topbar has no equivalent of — the Topbar's own
 * mobile touch target comes from a `max-[721px]:size-[44px]` breakpoint, which has no meaning in
 * a rail that never resizes by media query (`docs/lessons.md` / #112's settled plan: one
 * breakpoint, owned by `lib/shell-rail.ts`, not a `max-[…]` variant here).
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
const HIGHLIGHT_STATE = "border-l-[length:var(--border-width-bold)] border-l-transparent " +
  "data-highlighted:border-l-primary active:bg-surface-sunken outline-none " +
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
  "border-b-[length:var(--border-width-hair)] [border-bottom-style:solid] border-b-border";
const HEAD_BUTTON = HIGHLIGHT_STATE;
const EMPTY = "px-[var(--space-4)] py-[var(--space-5)] text-[length:var(--text-sm)] text-muted-foreground";
const TRIGGER = "relative inline-grid place-items-center size-[34px] text-foreground hover:bg-secondary";

// 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token. Applied only when the
// caller (`ShellHeader`, below 772px) asks for it via `touchTarget` — the desktop 250px/48px rail
// keeps the trigger's own 34px box, same as the Topbar's default. Both axes: `size-`, so
// tailwind-merge replaces TRIGGER's `size-[34px]` rather than leaving the width at 34.
const TOUCH_TARGET = "size-[44px]";

export type NotificationBellProps = {
  /** Poll interval override, for tests — mirrors the Topbar's `notificationPollMs`. */
  poll?: number;
  /** True in the narrow header, where every control must clear 44px. */
  touchTarget?: boolean;
};

export function NotificationBell({ poll = NOTIFICATION_POLL_MS, touchTarget = false }: NotificationBellProps) {
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const notificationsPopupRef = useRef<HTMLDivElement | null>(null);
  // Set only by `dismissNotification`, consumed by the layout effect below — never a timer, per
  // the Topbar's own §7.1 rule: a deferred focus call can land after the list has changed again.
  const pendingDismissFocusRef = useRef<string | "menu" | null>(null);

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
    const menu = notificationsPopupRef.current;
    if (target === "menu") { menu?.focus(); return; }
    menu?.querySelector<HTMLButtonElement>(`[data-notification-dismiss="${CSS.escape(target)}"]`)?.focus();
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

  async function dismissNotification(notification: NotificationItem) {
    const notificationIndex = notifications.findIndex((item) => item.id === notification.id);
    const focusTargetId = notificationIndex < 0 ? null : notifications[notificationIndex + 1]?.id ?? notifications[notificationIndex - 1]?.id ?? null;
    pendingDismissFocusRef.current = focusTargetId ?? "menu";
    setNotifications((current) => current.filter((item) => item.id !== notification.id));
    if (!notification.readAt) setUnreadCount((current) => Math.max(0, current - 1));
    try { await apiDelete("/api/notifications/" + encodeURIComponent(notification.id)); } catch { /* The next poll restores server state. */ }
  }

  return (
    <div className="relative" data-testid="rail-notifications">
      <Menu
        open={notificationsOpen}
        onOpenChange={setNotificationsOpen}
        triggerLabel={unreadCount ? `${unreadCount} unread notifications` : "Notifications"}
        label="Notifications"
        triggerClassName={cn(TRIGGER, "[&_svg]:size-[19px]", touchTarget && TOUCH_TARGET)}
        triggerTestId="rail-notification-trigger"
        panelClassName="max-w-[min(360px,calc(100vw-var(--space-5)))] max-h-[min(520px,calc(100dvh-var(--space-9)))]"
        popupRef={notificationsPopupRef}
        trigger={
          // `display: contents` — a real DOM node to carry the `data-touch-target` test seam
          // without changing the trigger's own layout box (see the header comment: the Topbar has
          // no equivalent seam, so there is nothing to diverge from here).
          <span className="contents" data-touch-target={touchTarget ? true : undefined}>
            <Bell aria-hidden="true" />
            <span className="sr-only">Notifications</span>
            {unreadCount > 0 && <span className="bg-destructive !text-destructive-foreground text-[length:var(--text-2xs)]" aria-label={`${unreadCount} unread`} data-testid="rail-notification-badge">{unreadCount > 99 ? "99+" : unreadCount}</span>}
          </span>
        }
      >
        <div className={HEAD}>
          <span className="ey">Notifications</span>
          {unreadCount > 0 && <MenuPrimitive.Item nativeButton closeOnClick={false} render={<Button variant="text" className={HEAD_BUTTON} />} onClick={() => void markAllNotificationsRead()} data-testid="rail-mark-all-read">Mark all read</MenuPrimitive.Item>}
        </div>
        {notifications.length === 0 ? <div className={EMPTY} role="none" data-testid="rail-notifications-empty">You’re all caught up.</div> : notifications.map((notification) => {
          const route = projectNotificationRoute(notification.projectId, notification.type);
          return <div key={notification.id} role="none" className={ROW} data-unread={notification.readAt ? undefined : ""}>
            {route?.kind === "project"
              ? <MenuPrimitive.LinkItem
                  render={<InternalLink to={staffPathFor(route)} className={ITEM} />}
                  closeOnClick
                  label={notification.title}
                  onClick={() => void markNotificationRead(notification)}
                  data-testid="rail-notification-item"
                  data-notification-route="project"
                ><strong className={ITEM_TITLE}>{notification.title}</strong>{notification.body && <span className={ITEM_BODY}>{notification.body}</span>}<small className={ITEM_META}>{new Date(notification.createdAt).toLocaleString()}</small></MenuPrimitive.LinkItem>
              : <MenuPrimitive.Item
                  nativeButton
                  closeOnClick
                  render={<button type="button" className={ITEM} />}
                  label={notification.title}
                  onClick={() => void markNotificationRead(notification)}
                  data-testid="rail-notification-item"
                  data-notification-route="none"
                ><strong className={ITEM_TITLE}>{notification.title}</strong>{notification.body && <span className={ITEM_BODY}>{notification.body}</span>}<small className={ITEM_META}>{new Date(notification.createdAt).toLocaleString()}</small></MenuPrimitive.Item>}
            <MenuPrimitive.Item
              nativeButton
              closeOnClick={false}
              render={<button type="button" className={DISMISS} />}
              label={`Dismiss ${notification.title}`}
              aria-label={`Dismiss notification: ${notification.title}`}
              data-notification-dismiss={notification.id}
              onClick={() => void dismissNotification(notification)}
            >×</MenuPrimitive.Item>
          </div>;
        })}
      </Menu>
    </div>
  );
}
