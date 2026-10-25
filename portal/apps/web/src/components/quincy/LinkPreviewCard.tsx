import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { RichTextLinkPreview } from "@quincy/shared";
import { embeddedMediaUrl } from "../../lib/embedded-media-core";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "../reui/item";

type CardAttrs = RichTextLinkPreview["attrs"];

const hostAndPath = (url: string) => { try { const parsed = new URL(url); return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname === "/" ? "" : parsed.pathname}`; } catch { return url; } };

/**
 * The card for a link in a post (#497): site, title, description and a small image, as one link that opens the address the author
 * typed in a new tab. The image is read through the auth-gated `/media/embedded/:id` route like any embedded media, and a card whose
 * image cannot load just drops it. A card the server could not fill in (its row is gone) has no address and renders nothing.
 * `interactive={false}` (the composer) renders the same card as a plain block with no address, so a click only selects the node. Built on the installed ReUI `item` (outline, as an `<a>`); neither ReUI nor base-nova has a link-preview component.
 */
export function LinkPreviewCard({ attrs, actions, testId = "link-preview-card", interactive = true, mediaUrl = embeddedMediaUrl, className }: { attrs: CardAttrs; actions?: ReactNode; testId?: string; interactive?: boolean; mediaUrl?: (mediaId: string) => string; /** The note box's card list spaces its cards itself (#951, B1). */ className?: string }) {
  const [imageFailed, setImageFailed] = useState(false);
  if (!attrs.url) return null;
  const showImage = Boolean(attrs.imageMediaId) && !imageFailed;
  return <div className={cn("relative my-[var(--space-2)]", className)}>
    <Item variant="outline" size="sm" data-testid={testId} className="flex-nowrap items-start rounded-[var(--radius-xs)]" render={interactive ? <a href={attrs.url} target="_blank" rel="noopener noreferrer nofollow" /> : undefined}>
      {showImage && <ItemMedia variant="image" className="rounded-[var(--radius-xs)] size-16 group-data-[size=sm]/item:size-16 max-[721px]:size-12 max-[721px]:group-data-[size=sm]/item:size-12">
        <img data-testid="link-preview-image" src={mediaUrl(attrs.imageMediaId!)} alt="" loading="lazy" decoding="async" onError={() => setImageFailed(true)} />
      </ItemMedia>}
      <ItemContent className={actions ? "min-w-0 pr-[var(--space-6)] max-[721px]:pr-11 pointer-coarse:pr-11" : "min-w-0"}>
        {attrs.siteName && <span data-slot="link-preview-meta" className="text-xs text-foreground-secondary">{attrs.siteName}</span>}
        <ItemTitle className="line-clamp-2 break-words">{attrs.title ?? hostAndPath(attrs.url)}</ItemTitle>
        {attrs.description && <ItemDescription className="text-foreground-secondary">{attrs.description}</ItemDescription>}
        {!attrs.title && attrs.description === null ? null : <span data-slot="link-preview-meta" className="truncate text-xs text-foreground-secondary">{hostAndPath(attrs.url)}</span>}
      </ItemContent>
    </Item>
    {actions}
  </div>;
}
