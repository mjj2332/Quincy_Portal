import { LayoutGrid, List } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "../reui/toggle-group";
import { IconTip } from "./IconTip";
import type { VideoLayout } from "../../lib/video-layout-pref";

/**
 * Tiles or list (#933, #938): the one layout switch for the staff Video toolbar, the guest Review link page (#940) and the Delivery page (#941). A ReUI `ToggleGroup` in its scoped
 * `segment` variant, as the Timeline's Colour by (`ProductionGanttColourBy.tsx`): two icon segments, each named ("Tiles", "List") and with its name in a tooltip, the group named
 * "Layout". One choice is always pressed; pressing the pressed one (an empty selection) changes nothing. The segments are 44px at <=721px and on a coarse pointer (`toggle.tsx` item 7).
 * Guest-safe: it imports no staff module.
 */
export function VideoLayoutToggle({ value, onChange, className }: { value: VideoLayout; onChange: (next: VideoLayout) => void; className?: string }) {
  return <ToggleGroup
    variant="segment" size="segment" spacing={0.5} aria-label="Layout" data-testid="video-layout-toggle" {...(className ? { className } : {})}
    value={[value]}
    onValueChange={(next) => { const picked = next[0]; if ((picked === "tiles" || picked === "rows") && picked !== value) onChange(picked); }}
  >
    <IconTip label="Tiles"><ToggleGroupItem value="tiles" aria-label="Tiles" data-testid="video-layout-tiles"><LayoutGrid aria-hidden="true" /></ToggleGroupItem></IconTip>
    <IconTip label="List"><ToggleGroupItem value="rows" aria-label="List" data-testid="video-layout-rows"><List aria-hidden="true" /></ToggleGroupItem></IconTip>
  </ToggleGroup>;
}
