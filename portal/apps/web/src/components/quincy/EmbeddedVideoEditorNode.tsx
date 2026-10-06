import { useState } from "react";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { VideoIcon } from "lucide-react";
import { EmbeddedVideo } from "../../lib/rich-text-tiptap";
import { embeddedMediaPosterUrl, embeddedMediaUrl } from "../../lib/embedded-media";
import { Badge } from "../reui/badge";

function EmbeddedVideoEditorView({ node }: NodeViewProps) {
  const mediaId = String(node.attrs.mediaId ?? "");
  const [failed, setFailed] = useState(false);
  const hasPoster = node.attrs.hasPoster !== false;
  // `hasPoster === false` (the server kept no frame) leaves `poster` off so the browser never requests a 404; null or absent means unknown and asks, as before.
  return <NodeViewWrapper className="rich-text__embedded-video-node" contentEditable={false}>
    {failed
      ? <div data-testid="embedded-video-preview-unavailable" className="rich-text__embedded-video rich-text__embedded-video--unavailable"><p className="m-0 text-foreground-secondary [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]">Preview unavailable in this browser</p></div>
      : <video src={hasPoster ? embeddedMediaUrl(mediaId) : `${embeddedMediaUrl(mediaId)}#t=0.1`} poster={hasPoster ? embeddedMediaPosterUrl(mediaId) : undefined} preload="metadata" muted playsInline data-media-id={mediaId} data-drag-handle="" onError={() => setFailed(true)} className="rich-text__embedded-video cursor-grab active:cursor-grabbing" />}
    <Badge variant="invert" data-testid="embedded-video-badge" className="pointer-events-none absolute top-[var(--space-2)] left-[var(--space-2)]"><VideoIcon aria-hidden="true" />Video</Badge>
  </NodeViewWrapper>;
}

/** The editor's `video` node with the muted preview and a "Video" badge over it (#556), so a poster frame does not read as a still image. */
export const EmbeddedVideoWithView = EmbeddedVideo.extend({
  addNodeView() { return ReactNodeViewRenderer(EmbeddedVideoEditorView); },
});
