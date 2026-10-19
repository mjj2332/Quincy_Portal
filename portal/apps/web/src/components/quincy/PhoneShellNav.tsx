import { useRef, useState, type RefObject } from "react";
import { useNotificationFeed } from "../../lib/use-notifications";
import { NOTIFICATION_POLL_MS, NotificationPopover } from "./NotificationBell";
import { useSheetNotifications } from "./RailedShell";
import { ShellNavTrigger } from "./ShellHeader";

/**
 * The phone Dashboard's nav trigger, with the bell folded into it (#923, owner decision). At <=721px the
 * view bar has no room for a 44px bell beside its picker, so:
 *
 * - the menu button (`ShellNavTrigger`) carries the unread count, drawn as the bell drew it, and its
 *   name says it ("Open navigation, 5 unread notifications");
 * - the nav Sheet gets a Notifications row (`useSheetNotifications`, drawn by `NavigationRail`);
 * - choosing that row closes the Sheet and opens the bell's own panel (`NotificationPopover`, the same
 *   component and placement as the narrow bell: flush under the bar's row, its full width). On close,
 *   focus goes back to the menu button, the entry point the viewer can see.
 *
 * One feed for all three (`useNotificationFeed`), so the phone polls once, as the bell did.
 */
export function PhoneShellNav({ anchorRef, className }: { anchorRef: RefObject<HTMLElement | null>; className?: string }) {
  const feed = useNotificationFeed({ poll: NOTIFICATION_POLL_MS });
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useSheetNotifications({
    unreadCount: feed.unreadCount,
    open: () => {
      feed.refreshNow();
      setOpen(true);
    },
  });

  return (
    <>
      <ShellNavTrigger ref={triggerRef} unreadCount={feed.unreadCount} className={className} />
      <NotificationPopover
        feed={feed}
        open={open}
        onOpenChange={setOpen}
        trigger={false}
        finalFocus={triggerRef}
        placement="header"
        anchorRef={anchorRef}
        touchTarget
      />
    </>
  );
}
