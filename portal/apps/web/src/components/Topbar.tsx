import type { MouseEvent } from "react";
import { signOut } from "../lib/auth";

export type AppView = "dashboard" | "project" | "create-project" | "admin";

interface TopbarProps {
  activeView: AppView;
  canAccessAdmin: boolean;
  user: { name?: string | null; email?: string | null };
  onNavigate: (view: AppView) => void;
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

export function Topbar({ activeView, canAccessAdmin, onNavigate, user }: TopbarProps) {
  const displayName = user.name || user.email || "Quincy user";

  async function handleSignOut(event: MouseEvent<HTMLButtonElement>) {
    event.currentTarget.disabled = true;
    try {
      await signOut();
    } finally {
      event.currentTarget.disabled = false;
    }
  }

  return (
    <header className="topbar">
      <button className="topbar__brand button--text" type="button" onClick={() => onNavigate("dashboard")} aria-label="Quincy Portal home">
        <img src="/brand/quincy-wordmark-black.png" alt="Quincy Productions" />
      </button>
      <div className="topbar__divider" />
      <nav className="topnav" aria-label="Primary navigation">
        <button type="button" className={activeView === "dashboard" ? "is-active" : ""} onClick={() => onNavigate("dashboard")}>
          Dashboard
        </button>
        {canAccessAdmin && (
          <button type="button" className={activeView === "admin" ? "is-active" : ""} onClick={() => onNavigate("admin")}>
            Admin
          </button>
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
    </header>
  );
}
