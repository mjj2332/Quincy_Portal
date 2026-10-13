import { CheckIcon, ChevronUpIcon } from "lucide-react";
import { TIME_FORMATS, type TimeFormat } from "@quincy/shared";
import { TIME_FORMAT_LABELS, useTimeFormat } from "../../lib/time-format-prefs";
import { Button } from "../reui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../reui/tooltip";
import { MENU_ITEM, Menu, MenuPrimitive } from "./menu";

const COARSE = "pointer-coarse:min-h-11 pointer-coarse:min-w-11 max-[721px]:min-h-11 max-[721px]:min-w-11";
const EYEBROW = "[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-[color:var(--muted-foreground)]";

/**
 * The time-format choice (#860): Timecode, Standard or Frames, opening upward from an icon button beside the player's readout. It is a separate
 * button, not the readout itself, so the readout's live region never sits inside a button. The choice is the browser-wide preference, so the
 * single player, Compare and the guest page all follow it.
 */
export function TimeFormatMenu() {
  const [format, setFormat] = useTimeFormat();
  return <Tooltip>
    <Menu
      label="Time format"
      triggerLabel={`Time format: ${TIME_FORMAT_LABELS[format]}`}
      triggerTestId="video-time-format-trigger"
      triggerRender={<TooltipTrigger render={<Button type="button" variant="ghost" size="icon-sm" className={COARSE}><ChevronUpIcon aria-hidden="true" /></Button>} />}
      side="top"
      align="start"
    >
      <MenuPrimitive.Group>
        <MenuPrimitive.GroupLabel className={`px-[var(--space-3)] pt-[var(--space-2)] pb-[var(--space-1)] ${EYEBROW}`}>Time format</MenuPrimitive.GroupLabel>
        <MenuPrimitive.RadioGroup value={format} onValueChange={(value) => { setFormat(value as TimeFormat); }} aria-label="Time format">
          {TIME_FORMATS.map((id) => <MenuPrimitive.RadioItem key={id} value={id} data-testid={`video-time-format-${id}`} className={`${MENU_ITEM} relative pe-[var(--space-6)] pointer-coarse:min-h-11`}>
            {TIME_FORMAT_LABELS[id]}
            <MenuPrimitive.RadioItemIndicator className="absolute end-[var(--space-3)]"><CheckIcon aria-hidden="true" className="size-4" /></MenuPrimitive.RadioItemIndicator>
          </MenuPrimitive.RadioItem>)}
        </MenuPrimitive.RadioGroup>
      </MenuPrimitive.Group>
    </Menu>
    <TooltipContent>Time format</TooltipContent>
  </Tooltip>;
}
