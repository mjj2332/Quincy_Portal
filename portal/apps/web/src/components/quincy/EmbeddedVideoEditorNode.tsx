import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { VideoIcon } from "lucide-react";
import { EmbeddedVideo } from "../../lib/rich-text-tiptap";
import { embeddedMediaPosterUrl, embeddedMediaUrl } from "../../lib/embedded-media";
import { Badge } from "../reui/badge";

function EmbeddedVideoEditorView({ node }: NodeViewProps) {
  const mediaId = String(node.attrs.mediaId ?? "");
  // `hasPoster === false` (the server kept no frame) leaves `poster` off so the browser never requests a 404; null or absent means unknown and asks, as before.
  return <NodeViewWrapper className="rich-text__embedded-video-node" contentEditable={false}>
    <video src={embeddedMediaUrl(mediaId)} poster={node.attrs.hasPoster === false ? undefined : embeddedMediaPosterUrl(mediaId)} preload="metadata" muted playsInline data-media-id={mediaId} data-drag-handle="" className="rich-text__embedded-video cursor-grab active:cursor-grabbing" />
    <Badge variant="invert" data-testid="embedded-video-badge" className="pointer-events-none absolute top-[var(--space-2)] left-[var(--space-2)]"><VideoIcon aria-hidden="true" />Video</Badge>
  </NodeViewWrapper>;
}

/** The editor's `video` node with the muted preview and a "Video" badge over it (#556), so a poster frame does not read as a still image. */
export const EmbeddedVideoWithView = EmbeddedVideo.extend({
  addNodeView() { return ReactNodeViewRenderer(EmbeddedVideoEditorView); },
});
