import { useMemo } from "react";
import { QuincyRichTextEditorBase, type QuincyRichTextEditorBaseProps } from "./QuincyRichTextEditorBase";
import { embeddedMediaPosterUrl, embeddedMediaUrl, abortEmbeddedImage, retryEmbeddedRendition, uploadEmbeddedImage, uploadEmbeddedVideo, type EditorMediaTransport, type EmbeddedMediaScope } from "../lib/embedded-media";
import { useEmbeddedHeicEnabled } from "../lib/use-embedded-heic";
import { requestLinkPreview } from "../lib/link-previews";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_PER_POST, attachmentUrl, uploadAttachment, uploadNoticeAttachment, type EditorAttachmentTransport } from "../lib/attachments";
import type { MentionableUser } from "./MentionAutocomplete";

/**
 * The staff rich-text editor (#491, #492): `QuincyRichTextEditorBase` with the staff transport injected (#835). Media uploads run over `lib/embedded-media` into this Project or the
 * Notice board, link previews over `lib/link-previews`, and the @ list from the host. The Review-link page uses the base with its own transport; see the base for what the editor is.
 */
export type QuincyRichTextEditorProps = Omit<QuincyRichTextEditorBaseProps, "media" | "linkPreviews" | "loadMentionables" | "mentions" | "attachments"> & {
  loadMentionables: (query: string) => Promise<MentionableUser[]>;
  /** Turns on embedded images (#493, #496): the toolbar button, paste and drop upload into this Project or the Notice board. A Project also takes video (#494). */
  media?: EmbeddedMediaScope;
  /** Turns on link previews (#497): applying a link asks the server for the page's card and inserts it after the link's block. */
  linkPreviews?: EmbeddedMediaScope;
  /** Turns on Attachments on a Project discussion comment (#952) or a Notice board post (#954): any file that is not a photo or video to embed is attached to it. */
  attachments?: { projectId: string } | { noticeBoard: true };
};

export function QuincyRichTextEditor({ media, linkPreviews, attachments, ...rest }: QuincyRichTextEditorProps) {
  // Whether this person may upload HEIC (#495), asked of the server only when the editor takes media at all.
  const heicEnabled = useEmbeddedHeicEnabled(media !== undefined);
  const transport = useMemo<EditorMediaTransport | undefined>(() => media === undefined ? undefined : {
    heicEnabled,
    video: "projectId" in media,
    mediaUrl: embeddedMediaUrl,
    posterUrl: embeddedMediaPosterUrl,
    uploadImage: (file, onProgress, options) => uploadEmbeddedImage(media, file, onProgress, options),
    uploadVideo: (file, options) => "projectId" in media ? uploadEmbeddedVideo(media.projectId, file, { ...options, ...(media.owner ? { owner: media.owner } : {}) }) : Promise.reject(new Error("This surface takes no video.")),
    abort: (mediaId) => abortEmbeddedImage(media, mediaId),
    retryRendition: (mediaId, options) => retryEmbeddedRendition(media, mediaId, options),
  // `media` is read by identity: a host passing a fresh object each render only rebuilds this, which the editor reads through a ref.
  }, [media, heicEnabled]);
  const previews = useMemo(() => linkPreviews === undefined ? undefined : (url: string, signal?: AbortSignal) => requestLinkPreview(linkPreviews, url, signal), [linkPreviews]);
  // Keyed by value, not identity: a host passing a fresh object each render keeps the same transport.
  const attachmentScope = attachments === undefined ? undefined : "projectId" in attachments ? attachments.projectId : null;
  const files = useMemo<EditorAttachmentTransport | undefined>(() => attachmentScope === undefined ? undefined : {
    maxPerPost: ATTACHMENT_MAX_PER_POST, maxBytes: ATTACHMENT_MAX_BYTES, url: attachmentUrl,
    upload: (file, options) => attachmentScope === null ? uploadNoticeAttachment(file, options) : uploadAttachment(attachmentScope, file, options),
  }, [attachmentScope]);
  return <QuincyRichTextEditorBase {...rest} media={transport} linkPreviews={previews} attachments={files} />;
}
