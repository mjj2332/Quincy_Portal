import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";

import { Sheet } from "@/components/reui/sheet";
import { SidebarProvider } from "@/components/reui/sidebar";
import { cn } from "../../lib/utils";
import { locationStore } from "../../lib/router";
import { useMediaQuery } from "../../lib/use-media-query";
import { SHELL_NARROW_QUERY, type RailMode, type RailShortcutTarget } from "../../lib/shell-rail";
import { isSearchShortcut } from "../../lib/shell-search";
import type { StaffNavigation } from "../../lib/staff-navigation";
import { NavigationRail } from "./NavigationRail";
import { RailSheet } from "./RailSheet";
import { ShellHeader } from "./ShellHeader";

/**
 * Owns the narrow/wide mode and the Sheet's open state — issue #112, re-platformed onto
 * base-nova's `SidebarProvider` in #122 (ADR 0005) and reduced to an always-icon rail by #426
 * (ADR 0015).
 *
 * There is no collapse any more: no stored preference, no `localStorage`, no ⌘B, no
 * `onOpenChange`. `SidebarProvider` is pinned `open={false}` (the icon-only state `Sidebar`'s
 * `collapsible="icon"` renders), and `mode` is simply `narrow ? "sheet" : "rail"`.
 *
 * `sheetOpen` closes on a location change, on `mode` leaving `"sheet"`, and — a #112 review
 * finding — on a click on the link for the route already showing, which publishes the SAME
 * location and so never fires the location-change effect; the rail slot's click handler covers
 * that case directly.
 *
 * One `Sheet` Root (`reui/sheet.tsx`) wraps the rail slot and the content column in every mode —
 * it renders no DOM of its own, so this costs nothing while narrow, and it is what lets
 * `ShellHeader`'s trigger and `RailSheet`'s popup share a Root and use a real `Dialog.Trigger`.
 *
 * `SidebarProvider` wraps that `Sheet` Root in turn. Its own `data-slot="sidebar-wrapper"` div is
 * `.app--railed`'s ONE in-flow child now (`styles/app.css`) — the Sheet root and `RailSheet`'s
 * popup render no in-flow DOM of their own — so `className="min-w-0"` here is what stops a wide
 * table inside a page from pushing it past the viewport, the job
 * `.app--railed > :not(.app__rail) { min-width: 0 }` used to do before the rail owned its own
 * fixed/full-height positioning (#122). `app__shell` is the Sol-review fix for the wrapper's own
 * `min-h-svh`: `.app--impersonating`'s `padding-top: 42px` adds to that minimum rather than sharing
 * it, so a short impersonated page renders 42px taller than the viewport — `.app--impersonating
 * .app__shell { min-height: calc(100svh - 42px) }` (`styles/app.css`, unlayered, beside the
 * `.app__rail` rule) claws it back. The content column carries its own `min-w-0 flex-1`
 * directly, for the same reason: it is the provider wrapper's flex child now, not
 * `.app--railed`'s.
 *
 * The ⌘K window listener (#427, ADR 0015) no longer owns a search input — the rail and the Sheet
 * carry none at any width. It calls `onSearchShortcut`, and `ShellRoute` (`lib/app-router.tsx`)
 * decides what that means: focus the Dashboard toolbar's search, navigating to the Dashboard first
 * when the shortcut fires elsewhere. With the narrow Sheet open, the Sheet is closed first, and
 * that close must not hand focus back to the hamburger: `skipSheetRestoreRef` makes `RailSheet`'s
 * `finalFocus` return `false` ("do nothing") for exactly that close, so the search field keeps the
 * focus the shell just gave it. Every other close restores focus to the trigger as usual.
 */

export type RailedShellProps = {
  navigation: StaffNavigation;
  user: { name?: string | null; email?: string | null };
  /** #366: a modal Project sheet is open over the shell. ⌘K would open the rail sheet — the PARENT
   * dialog Root — underneath it, so the shortcut stands down. */
  shortcutsSuspended?: boolean;
  /** ⌘K: focus the Dashboard toolbar's search. Called after the navigation Sheet (if open) is closed. */
  onSearchShortcut?: () => void;
  /** #531: an Admin is impersonating — the navigation sheet leaves the banner uncovered. */
  impersonating?: boolean;
  children: ReactNode;
};

export function RailedShell({ navigation, user, shortcutsSuspended = false, onSearchShortcut, impersonating = false, children }: RailedShellProps) {
  const narrow = useMediaQuery(SHELL_NARROW_QUERY);
  const mode: RailMode = narrow ? "sheet" : "rail";

  const history = locationStore();
  const location = useSyncExternalStore(history.subscribe, history.getLocation, () => "/");
  const [sheetOpen, setSheetOpen] = useState(false);
  const skipSheetRestoreRef = useRef(false);
  const sheetOpenRef = useRef(false);
  sheetOpenRef.current = sheetOpen;

  useEffect(() => setSheetOpen(false), [location]);
  useEffect(() => {
    if (mode !== "sheet") setSheetOpen(false);
  }, [mode]);

  // ⌘K. It only asks the shell to focus the toolbar search; typing and Enter are what search. With
  // the Sheet open it closes the Sheet first so the request is not swallowed by the modal.
  useEffect(() => {
    if (shortcutsSuspended) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (
        !isSearchShortcut({
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          repeat: event.repeat,
          isComposing: event.isComposing,
          defaultPrevented: event.defaultPrevented,
          target: event.target as RailShortcutTarget | null,
        })
      ) {
        return;
      }
      event.preventDefault();
      if (sheetOpenRef.current) skipSheetRestoreRef.current = true;
      setSheetOpen(false);
      onSearchShortcut?.();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [shortcutsSuspended, onSearchShortcut]);

  // Base UI: `false` leaves focus alone, `true` restores it to the trigger.
  function sheetFinalFocus(): boolean {
    if (!skipSheetRestoreRef.current) return true;
    skipSheetRestoreRef.current = false;
    return false;
  }

  const contentColumn = (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col",
        "peer-data-[variant=inset]:m-[var(--space-2)] peer-data-[variant=inset]:ml-0",
        "peer-data-[variant=inset]:rounded-[var(--radius-card)]",
        "peer-data-[variant=inset]:bg-[color:var(--bg-surface)] peer-data-[variant=inset]:shadow-[var(--shadow-sm)]",
        "peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-[var(--space-2)]",
      )}
      data-rail-mode={mode}
    >
      <ShellHeader mode={mode} navigation={navigation} />
      {children}
    </div>
  );

  // `RailSheet` stays mounted in every mode (its popup renders nothing while closed), so a Sheet
  // that is open when the window widens finishes its own close instead of being torn out mid-exit.
  // `className="contents"` so this wrapper costs nothing in `NavigationRail`'s own root sizing —
  // it takes part in neither layout nor the box model, only in the click's bubble path.
  function closeSheetOnLinkClick(event: MouseEvent<HTMLDivElement>) {
    if ((event.target as Element).closest("a[href]")) setSheetOpen(false);
  }

  function handleSheetOpenChange(open: boolean) {
    setSheetOpen(open);
  }

  const railSlot = (
    <>
      <RailSheet finalFocus={sheetFinalFocus} impersonating={impersonating}>
        <div className="contents" onClick={closeSheetOnLinkClick}>
          <NavigationRail navigation={navigation} user={user} variant="sheet" showBell={false} />
        </div>
      </RailSheet>
      {mode !== "sheet" && <NavigationRail navigation={navigation} user={user} variant={mode} />}
    </>
  );

  return (
    // Pinned closed: the icon-only state is the only one the rail has (ADR 0015), so the provider
    // takes no `onOpenChange` and nothing can open it.
    <SidebarProvider open={false} className="app__shell min-w-0">
      <Sheet open={mode === "sheet" && sheetOpen} onOpenChange={handleSheetOpenChange}>
        {railSlot}
        {contentColumn}
      </Sheet>
    </SidebarProvider>
  );
}
