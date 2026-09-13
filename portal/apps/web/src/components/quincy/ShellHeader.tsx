import { Fragment } from "react";
import { PanelLeftIcon } from "lucide-react";

import { Button } from "@/components/reui/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/reui/breadcrumb";
import { SheetTrigger } from "@/components/reui/sheet";
import { InternalLink } from "../InternalLink";
import { NotificationBell } from "./NotificationBell";
import { buildStaffBreadcrumb, type StaffNavigation } from "../../lib/staff-navigation";
import type { RailMode } from "../../lib/shell-rail";

/**
 * The content column's header — issue #112. Built on base-nova's `breadcrumb` and
 * `sheet` (`reui/breadcrumb.tsx`, `reui/sheet.tsx`), from Tempo's `app-header.tsx`
 * (`tmp/ReUI-Test-2-tempo-v1.1.0/src/features/app-shell/components/app-header.tsx`): `sticky top-0
 * h-[50px] flex items-center gap-2 bg-background`, the trigger then the breadcrumb on the left. NOT
 * Tempo's `hidden md:flex` crumb-hiding, its right-hand toolbar, or `useIsMobile` — a `md:` variant
 * would be a second, CSS-owned breakpoint (`styles/shell-breakpoint.guard.test.ts` forbids it), and
 * #112's AC needs the FULL trail regardless of width, not a hidden one.
 *
 * - **Wide** (`expanded`/`collapsed`): the rail's own collapse toggle, plus the breadcrumb. Nothing
 *   else — the bell lives in `NavigationRail`'s own header at this width (#112 AC4).
 * - **Narrow** (`sheet`): the Sheet's own `SheetTrigger` in place of the toggle, the same
 *   breadcrumb, and the bell — the one thing collapse below 772px must not cost is an unread count
 *   nobody can see, and there is no rail on screen to hold it there.
 *
 * The trigger is a real `SheetTrigger`, not a plain button: `RailedShell`'s `Sheet` wraps both the
 * rail slot and this content column in one Root, so this header and `RailSheet`'s popup are
 * descendants of the SAME Root, and `SheetTrigger` wires `aria-haspopup`/`aria-expanded`/
 * `aria-controls` and the open call for free.
 *
 * ## The breadcrumb is pure, this component only renders it
 *
 * `buildStaffBreadcrumb` (`lib/staff-navigation.ts`) derives the trail from the SAME navigation
 * model `RailedShell` already computed, rather than re-deriving anything from the route — so the
 * breadcrumb cannot disagree with the rail about which item and child are active. Every segment but
 * the last carries an href and is a `BreadcrumbLink` over `InternalLink`; the last carries
 * `aria-current="page"` and no link — `reui/breadcrumb.tsx`'s `BreadcrumbPage` hardcodes
 * `role="link" aria-disabled="true" aria-current="page"` and spreads its own remaining props AFTER
 * those three, so passing `role={undefined}` and `aria-disabled={undefined}` here removes them
 * (React drops an attribute whose value is `undefined`) while `aria-current="page"` survives
 * untouched.
 */
export type ShellHeaderProps = {
  mode: RailMode;
  navigation: StaffNavigation;
  onToggleRail: () => void;
};

// Tempo's `bullet-separator.tsx`: a short painted bar between crumbs instead of a chevron.
function BulletSeparator() {
  return <span className="inline-flex h-0.5 w-2 shrink-0 rounded-full bg-foreground/30" />;
}

export function ShellHeader({ mode, navigation, onToggleRail }: ShellHeaderProps) {
  const narrow = mode === "sheet";
  const expanded = mode === "expanded";
  const crumbs = buildStaffBreadcrumb(navigation);

  return (
    <header
      // `shell-header` (styles/app.css) — a real rule, not a utility, for the z-index and
      // impersonation-banner offset: an unlayered app.css rule is what wins the impersonation
      // banner's own stacking without touching this component's Tailwind classes.
      className="shell-header sticky top-0 h-[50px] flex items-center gap-2 bg-background"
      data-testid="shell-header"
    >
      {narrow
        ? <SheetTrigger
            data-testid="shell-header-sheet-trigger"
            aria-label="Open navigation"
            render={<Button variant="ghost" size="icon" className="size-[44px]" />}
          >
            <PanelLeftIcon />
          </SheetTrigger>
        : <Button
            variant="ghost"
            size="icon-sm"
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse navigation" : "Expand navigation"}
            onClick={onToggleRail}
            data-testid="shell-header-rail-toggle"
          >
            <PanelLeftIcon />
          </Button>}

      <Breadcrumb aria-label="Breadcrumb" data-testid="shell-breadcrumb">
        <BreadcrumbList>
          {crumbs.map((segment, index) => (
            <Fragment key={`${segment.label}-${index}`}>
              {index > 0 && <BreadcrumbSeparator className="flex items-center"><BulletSeparator /></BreadcrumbSeparator>}
              <BreadcrumbItem>
                {segment.href === null
                  ? <BreadcrumbPage role={undefined} aria-disabled={undefined}>{segment.label}</BreadcrumbPage>
                  : <BreadcrumbLink render={<InternalLink to={segment.href} />}>{segment.label}</BreadcrumbLink>}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>

      {narrow && <NotificationBell touchTarget />}
    </header>
  );
}
