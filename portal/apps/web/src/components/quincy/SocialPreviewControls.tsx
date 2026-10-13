import { Notice } from "./Notice";
import { Button } from "./Button";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../reui/select";
import { ToggleGroup, ToggleGroupItem } from "../reui/toggle-group";

/** What a Social preview needs of an overlay: the picture and its name. A staff Project's resolved overlay and (#872) a guest payload's both fit. */
export type SocialOverlayFrame = { id: string; name: string; imageUrl: string };
export type SocialFit = "fill" | "fit";

/**
 * Social preview (#871), presentation only: the film framed 9:16 under the Project's overlay. The host owns the data and the choices; the player
 * owns the rule that nothing is marked, drawn or noted while it is on. Reused by the guest page (#872).
 */
export type SocialPreviewMode = {
  overlays: readonly SocialOverlayFrame[];
  /** The overlay on screen (null while none is). */
  currentId: string | null;
  onOverlay(id: string): void;
  fit: SocialFit;
  onFit(fit: SocialFit): void;
  status: "loading" | "ready" | "error";
  onRetry(): void;
};

const COARSE = "pointer-coarse:min-h-11 pointer-coarse:min-w-11 max-[721px]:min-h-11 max-[721px]:min-w-11";

/** The overlay switcher and the Fill / Fit choice, in the transport row where the range button sits. */
export function SocialPreviewControls({ social, imageFailed }: { social: SocialPreviewMode; imageFailed: boolean }) {
  const current = social.overlays.find((overlay) => overlay.id === social.currentId) ?? null;
  return <div data-testid="video-social-controls" className="flex flex-wrap items-center gap-[var(--space-2)]">
    {social.status === "loading" && <span role="status" className="text-foreground-secondary [font:var(--type-label)]">Loading overlays…</span>}
    {social.status === "error" && <>
      <Notice tone="critical" role="alert" className="py-[var(--space-1)]">Overlays could not be loaded.</Notice>
      <Button type="button" variant="secondary" data-testid="video-social-retry" onClick={social.onRetry}>Retry</Button>
    </>}
    {social.status === "ready" && social.overlays.length === 0 && <span className="text-foreground-secondary [font:var(--type-label)]">No overlay available</span>}
    {social.status === "ready" && imageFailed && <Notice tone="caution" role="alert" className="py-[var(--space-1)]">Overlay unavailable</Notice>}
    {social.status === "ready" && social.overlays.length === 1 && current && <span data-testid="video-social-overlay-name" className="[font:var(--type-label)]">{current.name}</span>}
    {social.status === "ready" && social.overlays.length > 1 && <Select value={current?.id ?? null} onValueChange={(next) => { if (typeof next === "string") social.onOverlay(next); }}>
      <SelectTrigger aria-label="Overlay" data-testid="video-social-overlay-select" className={cn("min-w-36", COARSE)}>
        <SelectValue>{() => <span className="block truncate">{current?.name ?? "Overlay"}</span>}</SelectValue>
      </SelectTrigger>
      <SelectContent className="w-auto min-w-(--anchor-width)">
        {social.overlays.map((overlay) => <SelectItem key={overlay.id} value={overlay.id} className={COARSE}>{overlay.name}</SelectItem>)}
      </SelectContent>
    </Select>}
    <ToggleGroup variant="outline" size="sm" spacing={0} aria-label="Film fit" value={[social.fit]} onValueChange={(next) => { const picked = next[0]; if (picked === "fill" || picked === "fit") social.onFit(picked); }}>
      <ToggleGroupItem value="fill" data-testid="video-social-fill" className={COARSE}>Fill</ToggleGroupItem>
      <ToggleGroupItem value="fit" data-testid="video-social-fit" className={COARSE}>Fit</ToggleGroupItem>
    </ToggleGroup>
  </div>;
}
