import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/reui/button";
import { buttonClasses } from "@/components/quincy/Button";
import { InternalLink } from "@/components/InternalLink";
import { TabStrip } from "@/components/quincy/TabStrip";
import { NotificationList, NotificationEmptyState } from "@/components/quincy/NotificationList";
import { useNotificationFeed } from "@/lib/use-notifications";
import { dismissFocusTarget, type NotificationFilter, type NotificationListItem } from "@/lib/notification-list";

/**
 * `/settings/notifications` (#115) — the full-page reading surface `NotificationBell.tsx`'s
 * footer links to. Shares the Bell's data layer (`useNotificationFeed`) and row markup
 * (`NotificationList`/`NotificationEmptyState`) entirely; this file owns only the page's own
 * chrome — head, tabs, the paged tabpanel and its "Load more" foot — none of which the popover
 * needs.
 *
 * ## No poll, a deliberate read
 *
 * `poll: null` — see `use-notifications.ts`'s own file header, "Paging and polling don't mix". A
 * `setInterval` reload racing a `loadMore` append would need a head/tail merge this ticket does
 * not build; the page instead refreshes on mount and whenever `loadMore` runs.
 *
 * ## Dismiss-focus handoff
 *
 * Mirrors `NotificationBell`'s own layout effect, sized to this page's layout instead of a
 * popover: `dismissFocusTarget` (`lib/notification-list.ts`) names the next surviving row's
 * dismiss button, falling back to the previous row's, and finally to the tabpanel itself when the
 * dismissed row was the only one visible. Set only by `dismissNotification`, consumed by a layout
 * effect keyed on the notification array and the active tab — never a timer, which could land
 * after the list has changed again.
 *
 * ## The "Load more" foot
 *
 * The button stays mounted in all four states (owner decision #6) rather than disappearing at the
 * end of the feed: "Load more" -> "Loading…" (`aria-busy`) -> either back to "Load more"/"Try
 * again" (a failed page keeps its cursor for the same retry) or, once `nextCursor` is `null`, "No
 * more notifications" with `aria-disabled` — never unmounted, so focus already on the button (a
 * keyboard user who just pressed it) has somewhere to stay. The adjoining `aria-live="polite"`
 * region echoes the same transition for a screen reader: how many rows a successful page added,
 * or that there is nothing left to add.
 */

const PAGE = "page !max-w-[var(--container-md)]";
const HEAD = "flex flex-wrap items-end justify-between gap-[var(--space-6)] mb-[var(--space-6)]";
const H1 = "[font:var(--type-h1)] tracking-[var(--tracking-tight)] m-0";
const LEDE = "mt-[var(--space-3)] mb-0 max-w-[46ch] " +
  "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] " +
  "text-foreground-secondary";
const HEAD_ACTIONS = "flex items-center gap-[var(--space-3)]";
const TABS_ROW = "mt-[var(--space-2)]";
const FOOT = "mt-[var(--space-6)] flex justify-center";

export function Notifications() {
  const idPrefix = useId();
  const {
    notifications, unreadCount, now, tab, setTab, filtered, buckets, visible,
    hasMore, loadingMore, loadMoreError, loadMore, markRead, markAllRead, dismiss,
  } = useNotificationFeed({ poll: null, paged: true });

  const tabpanelRef = useRef<HTMLDivElement | null>(null);
  // Set only by `dismissNotification`, consumed by the layout effect below — see the file header.
  const pendingDismissFocusRef = useRef<string | "panel" | null>(null);
  // Set only by the "Load more" click, consumed once the request settles — gates the live-region
  // announcement to an actual user-triggered page rather than the initial mount's own fetch.
  const loadMoreRequestedRef = useRef(false);
  const countBeforeLoadMoreRef = useRef(0);
  const [announcement, setAnnouncement] = useState("");

  useLayoutEffect(() => {
    const target = pendingDismissFocusRef.current;
    if (!target) return;
    pendingDismissFocusRef.current = null;
    const panel = tabpanelRef.current;
    if (target === "panel") { panel?.focus(); return; }
    const dismissButton = panel?.querySelector<HTMLButtonElement>(`[data-notification-dismiss="${CSS.escape(target)}"]`);
    // The tracked row may no longer be mounted (a reload dropped it, or the tab changed underneath
    // the pending handoff) — the tabpanel itself is the fallback rather than leaving focus stranded.
    if (dismissButton) dismissButton.focus(); else panel?.focus();
  }, [notifications, tab]);

  useEffect(() => {
    if (!loadMoreRequestedRef.current || loadingMore) return;
    loadMoreRequestedRef.current = false;
    if (loadMoreError) return; // The button's own "Try again" label already carries this state.
    const added = notifications.length - countBeforeLoadMoreRef.current;
    setAnnouncement(hasMore ? `Loaded ${added} more notifications` : "No more notifications");
  }, [loadingMore, loadMoreError, hasMore, notifications.length]);

  function selectTab(next: NotificationFilter) {
    // A pending dismiss handoff from the tab just left no longer refers to a row this tab shows.
    pendingDismissFocusRef.current = null;
    setTab(next);
  }

  function focusAllTabAndShowAll() {
    document.getElementById(`${idPrefix}-tab-all`)?.focus();
    selectTab("all");
  }

  function handleMarkAllClick() {
    // `aria-disabled`, not the `disabled` attribute, keeps focus on the control while this is a
    // no-op at zero unread.
    if (unreadCount === 0) return;
    void markAllRead();
  }

  function activateRow(notification: NotificationListItem) {
    void markRead(notification);
  }

  function dismissNotification(notification: NotificationListItem) {
    pendingDismissFocusRef.current = dismissFocusTarget(visible, notification.id) ?? "panel";
    void dismiss(notification);
  }

  const isEnd = !hasMore && !loadingMore && !loadMoreError;

  function handleLoadMoreClick() {
    if (isEnd || loadingMore) return;
    countBeforeLoadMoreRef.current = notifications.length;
    loadMoreRequestedRef.current = true;
    void loadMore();
  }

  const loadMoreLabel = loadingMore ? "Loading…" : loadMoreError ? "Try again" : hasMore ? "Load more" : "No more notifications";

  return (
    <main className={PAGE}>
      <header className={HEAD}>
        <div>
          <h1 className={H1}>Notifications</h1>
          <p className={LEDE}>Everything addressed to you, newest first.</p>
        </div>
        <div className={HEAD_ACTIONS}>
          <Button
            type="button"
            variant="ghost"
            data-testid="notifications-mark-all"
            aria-disabled={unreadCount === 0 ? "true" : undefined}
            onClick={handleMarkAllClick}
          >
            Mark all read
          </Button>
          <InternalLink
            to="/settings/notifications/preferences"
            className={buttonClasses("text", {})}
            data-testid="notifications-preferences-link"
          >
            Preferences
          </InternalLink>
        </div>
      </header>

      <TabStrip
        idPrefix={idPrefix}
        label="Filter notifications"
        value={tab}
        onValueChange={(next) => selectTab(next as NotificationFilter)}
        className={TABS_ROW}
        items={[
          // All has no count — an owner decision (#2): the page's own list is not a fixed total.
          { value: "all", label: "All" },
          { value: "unread", label: "Unread", count: unreadCount },
        ]}
      />

      <div
        ref={tabpanelRef}
        role="tabpanel"
        id={`${idPrefix}-panel-${tab}`}
        aria-labelledby={`${idPrefix}-tab-${tab}`}
        tabIndex={0}
      >
        {filtered.length === 0 ? (
          <NotificationEmptyState filter={tab} unreadCount={unreadCount} onShowAll={focusAllTabAndShowAll} />
        ) : (
          <NotificationList
            buckets={buckets}
            now={now}
            showThumbnails
            scale="page"
            onActivate={activateRow}
            onDismiss={dismissNotification}
          />
        )}
      </div>

      <div className={FOOT}>
        <Button
          type="button"
          variant="outline"
          data-testid="notifications-load-more"
          aria-busy={loadingMore ? "true" : undefined}
          aria-disabled={isEnd ? "true" : undefined}
          onClick={handleLoadMoreClick}
        >
          {loadMoreLabel}
        </Button>
      </div>
      <div aria-live="polite" className="sr-only">{announcement}</div>
    </main>
  );
}
