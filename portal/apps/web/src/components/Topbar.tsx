import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { signOut } from "../lib/auth";
import { apiDelete, apiGet, apiPost } from "../lib/api";
import { InternalLink } from "./InternalLink";
import { projectNotificationRoute, staffPathFor } from "@quincy/shared";
import { initials } from "../lib/initials";
import { Menu } from "./ui/menu";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

export type AppView = "dashboard" | "project" | "create-project" | "edit-project" | "admin" | "notifications" | "not-found";

interface TopbarProps {
  activeView: AppView;
  canAccessAdmin: boolean;
  user: { name?: string | null; email?: string | null };
  notificationPollMs?: number;
}

export const NOTIFICATION_POLL_MS = 25_000;
type NotificationItem = { id: string; projectId: string | null; type: string; title: string; body: string | null; readAt: string | null; createdAt: string };
type NotificationsResponse = { notifications: NotificationItem[]; unreadCount: number };

// §8.2 paint — the notification list rows. Highlight/hover split per §10.3: hover tints
// (`hover:bg-secondary`); unread state is a 3px ink leading rule (TB8-01's unread device, one
// step lighter), not the same paint as hover, so hovering a read row no longer looks unread.
const ROW = "grid grid-cols-[minmax(0,1fr)_auto] border-b-[length:var(--border-width-hair)] " +
  "[border-bottom-style:solid] border-b-border bg-transparent hover:bg-secondary " +
  "[border-left-style:solid] border-l-[length:var(--border-width-rule)] border-l-transparent " +
  "data-[unread]:border-l-primary";
// §10.3's full option-state set, shared by every menu item and dismiss control below:
// hover (`hover:bg-secondary`), keyboard-highlighted (Base UI's own `data-highlighted`, styled
// with the same structural ink leading-rule device the option lists elsewhere use — inset from
// the row's own 3px unread rule so the two states read as separate, never collide), press
// (`active:bg-surface-sunken`), and an inset focus-visible ring (options sit flush inside a
// bordered, `overflow-auto` panel; an outward ring would clip).
const HIGHLIGHT_STATE = "border-l-[length:var(--border-width-bold)] border-l-transparent " +
  "data-highlighted:border-l-primary active:bg-surface-sunken outline-none " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:-outline-offset-2";
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
  "[font:var(--type-mono)] text-[length:var(--text-md)] leading-none hover:!text-foreground hover:bg-secondary",
  /* 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token */
  HIGHLIGHT_STATE,
);
const HEAD = "flex items-center justify-between gap-[var(--space-3)] px-[var(--space-4)] py-[var(--space-3)] " +
  "border-b-[length:var(--border-width-hair)] [border-bottom-style:solid] border-b-border";
// "Mark all read" is a `Button` (shared primitive) rendered as a `Menu.Item` — it keeps `Button`'s
// own hover/disabled/press states and only adds the highlight ring `Button` doesn't know about.
const HEAD_BUTTON = HIGHLIGHT_STATE;
const EMPTY = "topbar__notification-empty px-[var(--space-4)] py-[var(--space-5)] text-[length:var(--text-sm)] text-muted-foreground";
const TRIGGER = "relative inline-grid place-items-center size-[34px] max-[720px]:size-[44px] " +
  "text-foreground hover:bg-secondary";
const MOBILE_ITEM = cn(
  "min-h-[44px] flex items-center px-[var(--space-3)] text-foreground text-left",
  "no-underline [font:var(--type-label)] uppercase tracking-[var(--tracking-wide)] cursor-pointer",
  "border-0 bg-transparent hover:bg-secondary data-[active]:bg-secondary",
  HIGHLIGHT_STATE,
);

export function Topbar({ activeView, canAccessAdmin, user, notificationPollMs = NOTIFICATION_POLL_MS }: TopbarProps) {
  const displayName = user.name || user.email || "Quincy user";
  const [menuOpen, setMenuOpen] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const notificationsPopupRef = useRef<HTMLDivElement | null>(null);
  // Set only by `dismissNotification`, consumed by the layout effect below — never a timer
  // (§7.1's rule: a deferred focus call can land after the list has changed again).
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
    const timer = window.setInterval(() => void loadNotifications(), notificationPollMs);
    return () => { active = false; window.clearInterval(timer); };
  }, [notificationPollMs]);

  // §8.1 item 5 — focus continuity when the focused row disappears. Runs in the same commit as
  // the removal (a layout effect keyed on the array), never a timer.
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

  async function handleSignOut(event: MouseEvent<HTMLButtonElement>) {
    const button = event.currentTarget;
    button.disabled = true;
    setSignOutError(null);
    setMenuOpen(false);
    try {
      await signOut();
    } catch (error) {
      setSignOutError(error instanceof Error ? error.message : "Sign out could not be completed. Please try again.");
    } finally {
      button.disabled = false;
    }
  }

  return (
    <header className="topbar">
      <InternalLink className="topbar__brand button--text" to="/" aria-label="Quincy Portal home">
        <img src="/brand/quincy-wordmark-black.png" alt="Quincy Productions" />
      </InternalLink>
      <div className="topbar__divider" />
      <nav className="topnav" aria-label="Primary navigation">
        <InternalLink className={activeView === "dashboard" ? "is-active" : ""} to="/">
          Dashboard
        </InternalLink>
        {canAccessAdmin && (
          <InternalLink className={activeView === "admin" ? "is-active" : ""} to="/admin">
            Admin
          </InternalLink>
        )}
      </nav>
      <div className="grow" />
      <div className="topbar__user">
        <div className="topbar__notifications">
          <Menu
            open={notificationsOpen}
            onOpenChange={setNotificationsOpen}
            triggerLabel={unreadCount ? `${unreadCount} unread notifications` : "Notifications"}
            label="Notifications"
            triggerClassName={cn("topbar__notification-trigger", TRIGGER)}
            panelClassName={cn(
              "topbar__notification-menu",
              "max-w-[min(360px,calc(100vw-var(--space-5)))] max-h-[min(520px,calc(100dvh-var(--space-9)))]",
            )}
            popupRef={notificationsPopupRef}
            trigger={<>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <span className="sr-only">Notifications</span>
              {unreadCount > 0 && <span className="topbar__notification-badge bg-destructive !text-destructive-foreground text-[length:var(--text-2xs)]" aria-label={`${unreadCount} unread`}>{unreadCount > 99 ? "99+" : unreadCount}</span>}
            </>}
          >
            <div className={HEAD}>
              <span className="ey">Notifications</span>
              {unreadCount > 0 && <MenuPrimitive.Item nativeButton closeOnClick={false} render={<Button variant="text" className={HEAD_BUTTON} />} onClick={() => void markAllNotificationsRead()}>Mark all read</MenuPrimitive.Item>}
            </div>
            {notifications.length === 0 ? <div className={EMPTY} role="none">You’re all caught up.</div> : notifications.map((notification) => {
              const route = projectNotificationRoute(notification.projectId, notification.type);
              return <div key={notification.id} role="none" className={ROW} data-unread={notification.readAt ? undefined : ""}>
                {route?.kind === "project"
                  ? <MenuPrimitive.LinkItem
                      render={<InternalLink to={staffPathFor(route)} className={cn(ITEM, "topbar__notification-item")} />}
                      closeOnClick
                      label={notification.title}
                      onClick={() => void markNotificationRead(notification)}
                    ><strong className={ITEM_TITLE}>{notification.title}</strong>{notification.body && <span className={ITEM_BODY}>{notification.body}</span>}<small className={ITEM_META}>{new Date(notification.createdAt).toLocaleString()}</small></MenuPrimitive.LinkItem>
                  : <MenuPrimitive.Item
                      nativeButton
                      closeOnClick
                      render={<button type="button" className={cn(ITEM, "topbar__notification-item")} />}
                      label={notification.title}
                      onClick={() => void markNotificationRead(notification)}
                    ><strong className={ITEM_TITLE}>{notification.title}</strong>{notification.body && <span className={ITEM_BODY}>{notification.body}</span>}<small className={ITEM_META}>{new Date(notification.createdAt).toLocaleString()}</small></MenuPrimitive.Item>}
                <MenuPrimitive.Item
                  nativeButton
                  closeOnClick={false}
                  render={<button type="button" className={cn(DISMISS, "topbar__notification-dismiss")} />}
                  label={`Dismiss ${notification.title}`}
                  aria-label={`Dismiss notification: ${notification.title}`}
                  data-notification-dismiss={notification.id}
                  onClick={() => void dismissNotification(notification)}
                >×</MenuPrimitive.Item>
              </div>;
            })}
          </Menu>
        </div>
        <div className="topbar__identity">
          <strong>{displayName}</strong>
          {user.email && user.name && <span className="ey">{user.email}</span>}
        </div>
        <InternalLink className={activeView === "notifications" ? "is-active button button--text" : "button button--text"} to="/settings/notifications">Notification preferences</InternalLink>
        <div className="avatar" aria-hidden="true">{initials(displayName)}</div>
        <button className="button button--text" type="button" onClick={handleSignOut}>
          Sign out
        </button>
      </div>
      {signOutError && <div className="topbar__signout-error" role="alert">{signOutError}</div>}
      <Menu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        triggerLabel="Open account and navigation menu"
        label="Account and navigation menu"
        triggerClassName="topbar__menu-trigger"
        panelClassName="topbar__mobile-menu"
        trigger={<span aria-hidden="true">Menu</span>}
      >
        <div className="topbar__mobile-identity"><strong>{displayName}</strong>{user.email && <span>{user.email}</span>}</div>
        <MenuPrimitive.LinkItem render={<InternalLink to="/" className={MOBILE_ITEM} />} closeOnClick data-active={activeView === "dashboard" ? "" : undefined}>Dashboard</MenuPrimitive.LinkItem>
        {canAccessAdmin && <MenuPrimitive.LinkItem render={<InternalLink to="/admin" className={MOBILE_ITEM} />} closeOnClick data-active={activeView === "admin" ? "" : undefined}>Admin</MenuPrimitive.LinkItem>}
        <MenuPrimitive.LinkItem render={<InternalLink to="/settings/notifications" className={MOBILE_ITEM} />} closeOnClick data-active={activeView === "notifications" ? "" : undefined}>Notification preferences</MenuPrimitive.LinkItem>
        <MenuPrimitive.Item nativeButton closeOnClick render={<button type="button" className={MOBILE_ITEM} />} onClick={(event) => { void handleSignOut(event as unknown as MouseEvent<HTMLButtonElement>); }}>Sign out</MenuPrimitive.Item>
      </Menu>
    </header>
  );
}
