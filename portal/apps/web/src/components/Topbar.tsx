import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import { signOut } from "../lib/auth";
import { apiDelete, apiGet, apiPost } from "../lib/api";
import { InternalLink } from "./InternalLink";

export type AppView = "dashboard" | "project" | "create-project" | "edit-project" | "admin" | "not-found";

interface TopbarProps {
  activeView: AppView;
  canAccessAdmin: boolean;
  user: { name?: string | null; email?: string | null };
  notificationPollMs?: number;
}

export const NOTIFICATION_POLL_MS = 25_000;
type NotificationItem = { id: string; projectId: string | null; type: string; title: string; body: string | null; readAt: string | null; createdAt: string };
type NotificationsResponse = { notifications: NotificationItem[]; unreadCount: number };

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function Topbar({ activeView, canAccessAdmin, user, notificationPollMs = NOTIFICATION_POLL_MS }: TopbarProps) {
  const displayName = user.name || user.email || "Quincy user";
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const notificationTriggerRef = useRef<HTMLButtonElement>(null);
  const notificationsRef = useRef<HTMLDivElement>(null);
  const notificationsId = useId();

  function closeMenu(returnFocus = false) {
    setMenuOpen(false);
    if (returnFocus) window.setTimeout(() => triggerRef.current?.focus(), 0);
  }

  useEffect(() => {
    if (!menuOpen) return;
    window.setTimeout(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus(), 0);
    function onKeyDown(event: KeyboardEvent) { if (event.key === "Escape") { event.preventDefault(); closeMenu(true); } }
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) closeMenu();
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("pointerdown", onPointerDown); };
  }, [menuOpen]);

  function closeNotifications(returnFocus = false) {
    setNotificationsOpen(false);
    if (returnFocus) window.setTimeout(() => notificationTriggerRef.current?.focus(), 0);
  }

  useEffect(() => {
    if (!notificationsOpen) return;
    window.setTimeout(() => notificationsRef.current?.querySelector<HTMLElement>('[role="menuitem"], [tabindex="-1"]')?.focus(), 0);
    function onKeyDown(event: KeyboardEvent) { if (event.key === "Escape") { event.preventDefault(); closeNotifications(true); } }
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!notificationsRef.current?.contains(target) && !notificationTriggerRef.current?.contains(target)) closeNotifications();
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("pointerdown", onPointerDown); };
  }, [notificationsOpen]);

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
    setNotifications((current) => current.filter((item) => item.id !== notification.id));
    if (!notification.readAt) setUnreadCount((current) => Math.max(0, current - 1));
    window.setTimeout(() => {
      const menu = notificationsRef.current;
      const target = focusTargetId ? menu?.querySelector<HTMLButtonElement>(`[data-notification-dismiss="${CSS.escape(focusTargetId)}"]`) : null;
      (target ?? menu)?.focus();
    }, 0);
    try { await apiDelete("/api/notifications/" + encodeURIComponent(notification.id)); } catch { /* The next poll restores server state. */ }
  }

  async function handleSignOut(event: MouseEvent<HTMLButtonElement>) {
    const button = event.currentTarget;
    button.disabled = true;
    setSignOutError(null);
    closeMenu();
    try {
      await signOut();
    } catch (error) {
      setSignOutError(error instanceof Error ? error.message : "Sign out could not be completed. Please try again.");
    } finally {
      button.disabled = false;
    }
  }

  function closeNavigationMenu() { closeMenu(); }

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
          <button ref={notificationTriggerRef} className="topbar__notification-trigger" type="button" aria-label={unreadCount ? `${unreadCount} unread notifications` : "Notifications"} aria-haspopup="menu" aria-expanded={notificationsOpen} aria-controls={notificationsId} onClick={() => setNotificationsOpen((current) => !current)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span className="sr-only">Notifications</span>
            {unreadCount > 0 && <span className="topbar__notification-badge" aria-label={`${unreadCount} unread`}>{unreadCount > 99 ? "99+" : unreadCount}</span>}
          </button>
          {notificationsOpen && <div ref={notificationsRef} id={notificationsId} className="topbar__notification-menu" role="menu" aria-label="Notifications" tabIndex={-1}>
            <div className="topbar__notification-head"><strong>Notifications</strong>{unreadCount > 0 && <button type="button" onClick={() => void markAllNotificationsRead()}>Mark all read</button>}</div>
            {notifications.length === 0 ? <div className="topbar__notification-empty" role="none">You’re all caught up.</div> : notifications.map((notification) => <div key={notification.id} role="none" className={`topbar__notification-row ${notification.readAt ? "" : "is-unread"}`}><button role="menuitem" type="button" className="topbar__notification-item" onClick={() => void markNotificationRead(notification)}><strong>{notification.title}</strong>{notification.body && <span>{notification.body}</span>}<small>{new Date(notification.createdAt).toLocaleString()}</small></button><button role="menuitem" type="button" className="topbar__notification-dismiss" aria-label={`Dismiss notification: ${notification.title}`} data-notification-dismiss={notification.id} onClick={() => void dismissNotification(notification)}><span aria-hidden="true">×</span></button></div>)}
          </div>}
        </div>
        <div className="topbar__identity">
          <strong>{displayName}</strong>
          {user.email && user.name && <span className="ey">{user.email}</span>}
        </div>
        <div className="avatar" aria-hidden="true">{initials(displayName)}</div>
        <button className="button button--text" type="button" onClick={handleSignOut}>
          Sign out
        </button>
      </div>
      {signOutError && <div className="topbar__signout-error" role="alert">{signOutError}</div>}
      <button ref={triggerRef} className="topbar__menu-trigger" type="button" aria-label="Open account and navigation menu" aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuId} onClick={() => setMenuOpen((current) => !current)}>
        <span aria-hidden="true">Menu</span>
      </button>
      {menuOpen && <div ref={menuRef} id={menuId} className="topbar__mobile-menu" role="menu" aria-label="Account and navigation menu">
        <div className="topbar__mobile-identity"><strong>{displayName}</strong>{user.email && <span>{user.email}</span>}</div>
        <InternalLink role="menuitem" className={activeView === "dashboard" ? "is-active" : ""} to="/" onClick={closeNavigationMenu}>Dashboard</InternalLink>
        {canAccessAdmin && <InternalLink role="menuitem" className={activeView === "admin" ? "is-active" : ""} to="/admin" onClick={closeNavigationMenu}>Admin</InternalLink>}
        <button role="menuitem" type="button" onClick={handleSignOut}>Sign out</button>
      </div>}
    </header>
  );
}
