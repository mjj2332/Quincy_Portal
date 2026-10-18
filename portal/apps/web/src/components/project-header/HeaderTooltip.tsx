import type { ComponentProps, ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/reui/tooltip";

/**
 * A tooltip never takes an Escape from the Project sheet (or from a popup it sits beside): Base UI stops Escape at an open tooltip,
 * and focus returning to a control after its popup closes opens the control's tooltip, so the next Escape would only close that.
 * The tooltip still closes; the Escape goes on (Base UI's documented `allowPropagation`).
 */
export const passEscape: NonNullable<ComponentProps<typeof Tooltip>["onOpenChange"]> = (open, details) => {
  if (!open && details.reason === "escape-key") details.allowPropagation();
};

/**
 * #914 story 23: the header's controls print no field label, so each names itself in a tooltip (the installed `reui/tooltip`, below
 * the control as Whiteboard's) as well as in its accessible name. The control is the tooltip's trigger through Base UI's `render`
 * composition, so a Select, Popover, Combobox or Menu trigger keeps its own behaviour and gains the hover and focus tooltip.
 */
export function HeaderTooltip({ label, children }: { label: string; children: ReactElement }) {
  return <Tooltip onOpenChange={passEscape}>
    <TooltipTrigger render={children} />
    <TooltipContent side="bottom" data-testid="header-tooltip">{label}</TooltipContent>
  </Tooltip>;
}
