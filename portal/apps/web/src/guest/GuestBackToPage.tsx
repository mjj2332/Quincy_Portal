import { ChevronLeft } from "lucide-react";
import { Button } from "../components/reui/button";

const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";

/**
 * Back to the Delivery page this review was opened from (#882, D34): a native `<a>` (never router or history navigation, so a reload or a new tab follows it too), on the film list, the desktop
 * bar and the phone bar. Named "Back to the Delivery page" everywhere; the visible label is "Delivery page", which that name contains, and `iconOnly` (the phone bar) shows the chevron alone.
 */
export function GuestBackToPage({ href, iconOnly = false, className = "" }: { href: string; iconOnly?: boolean; className?: string }) {
  return <Button variant="ghost" nativeButton={false} data-testid="guest-back-to-page" aria-label="Back to the Delivery page" className={`${TOUCH} ${className}`.trim()} render={<a href={href} />}>
    <ChevronLeft aria-hidden="true" />{!iconOnly && <span>Delivery page</span>}
  </Button>;
}
