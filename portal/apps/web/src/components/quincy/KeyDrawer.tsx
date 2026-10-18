import { useRef, useState, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/reui/button";
import { createDrawerHandle, Drawer, DrawerClose, DrawerContent, DrawerTitle, DrawerTrigger } from "@/components/reui/drawer";
import { Button as QuincyButton } from "./Button";

/**
 * #916 (frame 3c; owner decision D7, and the design review's item 4 for the Calendar): a phone's key. A 44px "Key" button
 * opens a bottom ReUI `Drawer` holding the key row the wider layouts draw inline (`children`: the `StageKeyRow`, whose chips
 * still write the Filter, or the Timeline's `PeopleKeyRow`) and, on the Timeline, the Colour by switch (`colourBySlot`).
 *
 * The trigger is detached (a Base UI drawer handle): it sits in the view's nav row beside Today and the arrows, while the
 * drawer's root stays where a Filter write cannot unmount it (the Timeline's always-mounted band, #255), so a chip press
 * that re-pends the chart never closes the open drawer. Focus returns to whichever Key button is mounted when it closes.
 *
 * Moved from `ProductionGanttPhone.tsx` (`GanttKeyDrawer`, #921) so the Calendar can share it.
 */
export type KeyDrawerState = { handle: ReturnType<typeof createDrawerHandle>; triggerRef: { current: HTMLButtonElement | null } };

/** One drawer and its trigger(s): hold it in the component that renders both. */
export function useKeyDrawer(): KeyDrawerState {
  const [handle] = useState(() => createDrawerHandle());
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return { handle, triggerRef };
}

export function KeyDrawerTrigger({ drawer, testIdPrefix }: { drawer: KeyDrawerState; testIdPrefix: string }) {
  return (
    <DrawerTrigger
      handle={drawer.handle}
      ref={drawer.triggerRef}
      data-testid={`${testIdPrefix}-key-button`}
      render={<QuincyButton type="button" variant="secondary" className="h-11 min-w-11" />}
    >
      Key
    </DrawerTrigger>
  );
}

export function KeyDrawer({ drawer, testIdPrefix, children, colourBySlot }: { drawer: KeyDrawerState; testIdPrefix: string; children: ReactNode; colourBySlot?: ReactNode }) {
  // Session row 16: a tap meant for the Colour by switch landed while the drawer was still sliding up, so it hit the
  // backdrop (Base UI dismisses on a press there) and closed the drawer. Pointer dismissal waits for the open to settle
  // (`onOpenChangeComplete`, which Base UI calls at once when there is no animation); Close, Escape and a swipe still work.
  const [open, setOpen] = useState(false);
  const [settled, setSettled] = useState(false);
  return (
    <Drawer
      handle={drawer.handle}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSettled(false);
      }}
      onOpenChangeComplete={(next) => setSettled(next)}
      disablePointerDismissal={open && !settled}
      swipeDirection="down"
      showSwipeHandle
    >
      <DrawerContent
        data-testid={`${testIdPrefix}-key-drawer`}
        finalFocus={() => drawer.triggerRef.current ?? true}
        className="border-border bg-background text-foreground shadow-[var(--shadow-lg)] data-[swipe-direction=down]:rounded-t-[var(--radius-lg)]"
      >
        <div className="flex shrink-0 items-center justify-between gap-[var(--space-2)] ps-[var(--space-4)] pe-[var(--space-2)] pt-[var(--space-2)]">
          <DrawerTitle className="m-0 text-foreground [font:var(--weight-regular)_var(--text-md)/var(--leading-snug)_var(--font-display)]">Key</DrawerTitle>
          <DrawerClose aria-label="Close key" render={<Button type="button" variant="ghost" size="icon-header" className="shrink-0 rounded-[var(--radius-pill)]" />}>
            <XIcon aria-hidden="true" />
          </DrawerClose>
        </div>
        <div className="flex min-h-0 flex-col gap-[var(--space-4)] overflow-y-auto px-[var(--space-4)] pt-[var(--space-2)] pb-[calc(var(--space-6)+env(safe-area-inset-bottom))]">
          {children}
          {colourBySlot}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
