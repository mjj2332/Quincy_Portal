import type { ReactElement } from "react";
import { Kbd } from "../reui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "../reui/tooltip";

/** An icon button's tooltip: its name, and the shortcut when it has one. The one tooltip wrapper for Quincy chrome. */
export function IconTip({ label, keys, children }: { label: string; keys?: string; children: ReactElement }) {
  return <Tooltip>
    <TooltipTrigger render={children} />
    <TooltipContent>{label}{keys && <Kbd>{keys}</Kbd>}</TooltipContent>
  </Tooltip>;
}
