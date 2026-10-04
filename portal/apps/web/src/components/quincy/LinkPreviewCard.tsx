import { useState, type ReactNode } from "react";
import type { RichTextLinkPreview } from "@quincy/shared";
import { embeddedMediaUrl } from "../../lib/embedded-media";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "../reui/item";

type CardAttrs = RichTextLinkPreview["attrs"];

const hostAndPath = (url: string) => { try { const parsed = new URL(url); return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname === "/" ? "" : parsed.pathname}`; } catch { return url; } };

/**
 * The card for a link in a post (#497): site, title, description and a small image, as one link that opens the address the author
 * typed in a new tab. The image is read through the auth-gated `/media/embedded/:id` route like any embedded media, and a card whose
 * image cannot load just drops it. A card the server could not fill in (its row is gone) has no address and renders nothing.
 * Built on the installed ReUI `item` (outline, as an `<a>`); neither ReUI nor base-nova has a link-preview component.
 */
export function LinkPreviewCard({ attrs, actions, testId = "link-preview-card" }: { attrs: CardAttrs; actions?: ReactNode; testId?: string }) {
  const [imageFailed, setImageFailed] = useState(false);
  if (!attrs.url) return null;
  const showImage = Boolean(attrs.imageMediaId) && !imageFailed;
  return <div className="relative my-[var(--space-2)]">
    <Item variant="outline" size="sm" data-testid={testId} className="flex-nowrap items-start" render={<a href={attrs.url} target="_blank" rel="noopener noreferrer nofollow" />}>
      {showImage && <ItemMedia variant="image" className="size-16">
        <img data-testid="link-preview-image" src={embeddedMediaUrl(attrs.imageMediaId!)} alt="" loading="lazy" decoding="async" onError={() => setImageFailed(true)} />
      </ItemMedia>}
      <ItemContent className="min-w-0">
        {attrs.siteName && <span className="text-xs text-foreground-secondary">{attrs.siteName}</span>}
        <ItemTitle className="line-clamp-2 break-words">{attrs.title ?? hostAndPath(attrs.url)}</ItemTitle>
        {attrs.description && <ItemDescription className="text-foreground-secondary">{attrs.description}</ItemDescription>}
        {!attrs.title && attrs.description === null ? null : <span className="truncate text-xs text-foreground-secondary">{hostAndPath(attrs.url)}</span>}
      </ItemContent>
    </Item>
    {actions}
  </div>;
}
