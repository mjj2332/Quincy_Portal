import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import { signOut } from "../lib/auth";
import { InternalLink } from "./InternalLink";

export type AppView = "dashboard" | "project" | "create-project" | "edit-project" | "admin" | "not-found";

interface TopbarProps {
  activeView: AppView;
  canAccessAdmin: boolean;
  user: { name?: string | null; email?: string | null };
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function Topbar({ activeView, canAccessAdmin, user }: TopbarProps) {
  const displayName = user.name || user.email || "Quincy user";
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [signOutError, setSignOutError] = useState<string | null>(null);

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
