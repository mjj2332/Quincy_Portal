import type { RichTextDoc, RichTextMediaNode } from "@quincy/shared";
import { splitNoteFiles, splitNoteMedia } from "../../lib/note-media-strip";
import { AttachmentChip, AttachmentList } from "./AttachmentChip";
import { RichTextContent, type RichTextMediaUrls } from "../RichTextContent";
import { EmbeddedImage } from "./EmbeddedImage";
import { EmbeddedVideo } from "./EmbeddedVideo";

/**
 * A posted note's body (#927 T1): its text, then one strip of its pictures and videos as 56px tiles, each opening the larger view.
 * Display only: an old note with a picture between paragraphs is stored as it was and reads with the picture in the strip
 * (`splitNoteMedia`). No prototype frame shows a posted note's media; the plan settles the strip. Guest-safe: nothing here reaches
 * the staff API, and a Review link passes its own `mediaUrl` / `posterUrl`.
 */
export function NoteBody({ content, className, mediaUrl, posterUrl, attachmentUrl }: { content: RichTextDoc; className?: string } & RichTextMediaUrls) {
  // #955: the files come out first and are drawn last, as the C4 chips (download links at `attachmentUrl`: the staff route, or a Review link's own).
  const { rest, files } = splitNoteFiles(content);
  const { text, media } = splitNoteMedia(rest);
  return <div className="flex min-w-0 flex-col gap-[var(--space-2)]">
    {text && <div data-testid="note-body-text" className="min-w-0"><RichTextContent content={text} className={className} mediaUrl={mediaUrl} posterUrl={posterUrl} attachmentUrl={attachmentUrl} /></div>}
    {media.length > 0 && <NoteMediaStrip media={media} mediaUrl={mediaUrl} posterUrl={posterUrl} />}
    {files.length > 0 && <AttachmentList>{files.map((node) => <AttachmentChip key={node.attrs.attachmentId} attachmentId={node.attrs.attachmentId} name={node.attrs.name} bytes={node.attrs.bytes} attachmentUrl={attachmentUrl} />)}</AttachmentList>}
  </div>;
}

/** The row of tiles, in document order. It wraps, so a narrow card never scrolls sideways. */
export function NoteMediaStrip({ media, mediaUrl, posterUrl }: { media: readonly RichTextMediaNode[] } & RichTextMediaUrls) {
  return <ul data-testid="note-media-strip" role="list" aria-label="Attached media" className="m-0 flex list-none flex-wrap gap-[var(--space-2)] p-0">
    {media.map((node) => <li key={`${node.type}-${node.attrs.mediaId}`} className="flex"><NoteMediaThumb node={node} mediaUrl={mediaUrl} posterUrl={posterUrl} /></li>)}
  </ul>;
}

/** One tile: an image opens the image dialog, a video the Portal's player. */
export function NoteMediaThumb({ node, mediaUrl, posterUrl }: { node: RichTextMediaNode } & RichTextMediaUrls) {
  if (node.type === "image") return <EmbeddedImage size="thumb" mediaId={node.attrs.mediaId} alt={node.attrs.alt} mediaUrl={mediaUrl} />;
  return <EmbeddedVideo size="thumb" mediaId={node.attrs.mediaId} hasPoster={node.attrs.hasPoster} mediaUrl={mediaUrl} posterUrl={posterUrl} />;
}
