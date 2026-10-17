import { PresentationIcon } from "lucide-react";
import { Button } from "@/components/reui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/reui/tooltip";
import { noteWhiteboardOpener, WHITEBOARD_OPEN_TESTID } from "./whiteboard-opener";
import { HEADER_ICON_CHIP } from "./header-styles";

/**
 * #498: the whiteboard's entry. A button, never a tab: #914 moved it out of the tab row into the status cluster (D1), beside
 * Project info, because it belongs to the whole Project. `variant="header"` is the cluster's outline chip; the Collaboration-only
 * view keeps the ghost button. It records itself as the board's opener, so closing the board returns focus here.
 */
export function WhiteboardButton({ onOpen, variant = "ghost" }: { onOpen: () => void; variant?: "ghost" | "header" }) {
  return <Tooltip>
    <TooltipTrigger render={<Button type="button" variant={variant === "header" ? "outline" : "ghost"} size={variant === "header" ? "icon-header" : "icon"} aria-label="Open whiteboard" data-testid={WHITEBOARD_OPEN_TESTID}
      className={variant === "header" ? HEADER_ICON_CHIP : "min-h-[44px] min-w-[44px]"}
      onClick={(event) => { noteWhiteboardOpener(event.currentTarget); onOpen(); }} />}>
      <PresentationIcon className={variant === "header" ? "size-[18px]" : "size-4"} aria-hidden="true" />
    </TooltipTrigger>
    <TooltipContent side="bottom">Open whiteboard</TooltipContent>
  </Tooltip>;
}
