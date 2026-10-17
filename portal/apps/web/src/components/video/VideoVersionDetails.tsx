import type { ReactNode } from "react";
import { Button } from "../quincy/Button";
import { Popover, PopoverContent, PopoverTrigger } from "../reui/popover";

/**
 * The Version's details behind a text button (#741 5b, extracted for #881): beside the notes title, and in the desktop pane's head when the pane is
 * Delivery alone (the notes part off, D8: there is no Details tab). `children` is the Version's detail rows.
 */
export function VideoVersionDetails({ children }: { children: ReactNode }) {
  return <Popover>
    <PopoverTrigger render={<Button type="button" variant="text" data-testid="video-details-button" className="pointer-coarse:min-h-11 max-[721px]:min-h-11" />}>Version details</PopoverTrigger>
    <PopoverContent align="end" className="w-[min(320px,calc(100vw-var(--space-5)))] max-h-[min(70dvh,520px)] overflow-y-auto" data-testid="video-details-popover">{children}</PopoverContent>
  </Popover>;
}
