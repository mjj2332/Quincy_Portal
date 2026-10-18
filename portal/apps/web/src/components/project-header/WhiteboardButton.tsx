import { PresentationIcon } from "lucide-react";
import { Button } from "@/components/reui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/reui/tooltip";
import { noteWhiteboardOpener, WHITEBOARD_OPEN_TESTID } from "./whiteboard-opener";
import { HEADER_ICON_CHIP } from "./header-styles";
import { passEscape } from "./HeaderTooltip";

/**
 * #498: the whiteboard's entry. A button, never a tab: #914 moved it out of the tab row into the status cluster (D1), beside
 * Project info, because it belongs to the whole Project. `variant="header"` is the cluster's outline chip; the Collaboration-only
 * view keeps the ghost button. It records itself as the board's opener, so closing the board returns focus here.
 */
export function WhiteboardButton({ onOpen, variant = "ghost", condensedCopy = false }: {
  onOpen: () => void;
  /** `header`: the cluster's outline chip; `bar`: the phone project bar's 44px ghost button with the larger icon (M1). */
  variant?: "ghost" | "header" | "bar";
  /** #914 D5: the condensed bar's copy. Its own test id, so the board's fallback return target stays Row A's button. */
  condensedCopy?: boolean;
}) {
  return <Tooltip onOpenChange={passEscape}>
    <TooltipTrigger render={<Button type="button" variant={variant === "header" ? "outline" : "ghost"} size={variant === "header" ? "icon-header" : "icon"} aria-label="Open whiteboard"
      data-testid={condensedCopy ? `${WHITEBOARD_OPEN_TESTID}-condensed` : WHITEBOARD_OPEN_TESTID} data-twin="whiteboard"
      className={variant === "header" ? HEADER_ICON_CHIP : "min-h-[44px] min-w-[44px]" /* WCAG 2.5.5 Enhanced target */}
      onClick={(event) => { noteWhiteboardOpener(event.currentTarget); onOpen(); }} />}>
      <PresentationIcon className={variant === "header" ? "size-[18px]" : variant === "bar" ? "size-5" : "size-4"} aria-hidden="true" />
    </TooltipTrigger>
    <TooltipContent side="bottom" data-testid="header-tooltip">Open whiteboard</TooltipContent>
  </Tooltip>;
}
