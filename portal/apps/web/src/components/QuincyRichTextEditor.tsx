import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { exitSuggestion } from "@tiptap/suggestion";
import { ChevronDownIcon, ImageIcon, ListChecksIcon, ListIcon, ListOrderedIcon, Redo2Icon, TableIcon, Undo2Icon, VideoIcon } from "lucide-react";
import { RICH_TEXT_JSON_MAX_BYTES, RICH_TEXT_MAX_LINK_PREVIEWS, imageAltFromFileName, richTextDocByteLength, richTextMediaIds, richTextPlainText, type RichTextDoc } from "@quincy/shared";
import { cn } from "../lib/utils";
import { useMediaQuery } from "../lib/use-media-query";
import { EMBEDDED_MEDIA_MAX_PER_POST, EMBEDDED_VIDEO_ACCEPT, RenditionFailedError, abortEmbeddedImage, embeddedImageAccept, embeddedImageProblem, embeddedVideoProblem, retryEmbeddedRendition, uploadEmbeddedImage, uploadEmbeddedVideo, type EmbeddedMediaScope } from "../lib/embedded-media";
import { useEmbeddedHeicEnabled } from "../lib/use-embedded-heic";
import { requestLinkPreview } from "../lib/link-previews";
import {
  EmbeddedImage,
  EmbeddedVideo,
  LinkPreview,
  createRichTextEditorExtensions,
  type RichTextEditorPreset,
  itemContainerDepth,
  mentionQuery,
  shouldBlockListIndent,
  stripEmbeddedDisplay,
  tiptapToRichTextDoc,
  toTiptap,
} from "../lib/rich-text-tiptap";
import { MentionAutocomplete, type MentionAutocompleteHandle, type MentionableUser } from "./MentionAutocomplete";
import { Button } from "./reui/button";
import { Input } from "./reui/input";
import { EmbeddedUploadTray, type EmbeddedUpload } from "./quincy/EmbeddedUploadTray";
import { LinkPreviewWithView } from "./quincy/LinkPreviewEditorNode";
import { EmbeddedImageWithView } from "./quincy/EmbeddedImageEditorNode";
import { EmbeddedVideoWithView } from "./quincy/EmbeddedVideoEditorNode";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./reui/dropdown-menu";
import { InputGroup, InputGroupAddon } from "./reui/input-group";
import { DeleteTableDialog } from "./reui/rich-text-editor/delete-table-dialog";
import { RichTextAlignMenu } from "./reui/rich-text-editor/rich-text-align";
import { RichTextHighlightPopover } from "./reui/rich-text-editor/rich-text-highlight";
import { RichTextLinkPopover } from "./reui/rich-text-editor/rich-text-link";
import { RichTextOutlineRail, scrollToRichTextHeading, useRichTextActiveHeading, useRichTextOutline } from "./reui/rich-text-editor/rich-text-outline";
import { RICH_TEXT_BASIC_SLASH_ITEMS, RICH_TEXT_SLASH_KEY, RichTextSlashCommand } from "./reui/rich-text-editor/rich-text-slash-menu";
import { useRichTextState } from "./reui/rich-text-editor/rich-text-state";
import { editorOwnsBubbleBar } from "./reui/rich-text-editor/rich-text-bubble-bar";
import { RICH_TEXT_TABLE_SLASH_ITEM, RichTextTableBubble, RichTextTableMenu, RichTextTableTools } from "./reui/rich-text-editor/rich-text-table";
import type { TableBubbleTier } from "./reui/rich-text-editor/rich-text-table-position";
import {
  RICH_TEXT_PHONE_QUERY,
  RichTextButton,
  RichTextToggle,
  RichTextToolbar,
  RichTextToolbarGroup,
  RichTextToolbarSeparator,
} from "./reui/rich-text-editor/rich-text-toolbar";

/**
 * The one Quincy rich-text editor, built on the vendored ReUI `rich-text-editor-2` parts in
 * `components/reui/rich-text-editor/` (#491, #492). `preset="composer"` is the compact
 * Project-discussion comment box: one `InputGroup` field with a roving-tabindex toolbar inside it.
 * `preset="document"` is the Notice board's page editor (#492): the same field plus alignment,
 * highlight and tables, a "/" block menu, a table bubble and an outline rail. The legacy
 * `RichTextEditor` is retired.
 *
 * What is deliberately NOT the vendor's:
 * - The extension set. The composer builds on `createRichTextEditorExtensions()` (the schema
 *   `parseRichTextDoc` accepts), never the vendor's `createRichTextExtensions`: that one enables h1,
 *   blockquote, code, codeBlock, hr, alignment and highlight, plus StarterKit's autolink, which turns
 *   a typed email into a `mailto:` mark the server rejects with a 400.
 * - The mention UI. `MentionAutocomplete` stays: the vendor's needs a synchronous candidate list
 *   (ours is async and project-scoped), pulls in cmdk, and lacks the #375 `aria-expanded` gate and
 *   Esc-in-any-state that `quincy/project-sheet-layers.ts` depends on.
 *
 * Retained from the legacy editor, each for a lessons.md reason: `rich-text__editor-content` on the
 * ProseMirror element (nine app.css selectors), `editorProps.handleKeyDown` with refs (callbacks
 * change per render), the `valueRef` no-op-transaction guard and the external `setContent` sync.
 */

/** The content surface inside an `InputGroup` that already draws the one border, ground and focus ring. */
const EDITOR_CONTENT_UTILITIES =
  "min-h-[var(--space-8)] w-full min-w-0 px-[var(--space-3)] py-[var(--space-2)] text-base md:text-sm " +
  "bg-transparent focus-visible:!outline-none ";

/** Room for the outline rail's dashes at the right edge (the rail is hidden on a phone). */
// scroll-mt: an outline-rail jump (`scrollToRichTextHeading`) must land the heading clear of the shell header AND the stuck toolbar (#594).
const DOCUMENT_CONTENT_UTILITIES = "min-[721px]:pe-12 [&_h2]:scroll-mt-[calc(var(--shell-header-height)+var(--impersonation-banner-height,0px)+var(--rich-text-toolbar-block,3rem))] [&_h3]:scroll-mt-[calc(var(--shell-header-height)+var(--impersonation-banner-height,0px)+var(--rich-text-toolbar-block,3rem))] ";

// The group wrapper's call-site divergences from `InputGroup` (#376): `has-disabled:bg-card` because
// the base's deep `:has(:disabled)` would paint the whole field sunken as soon as Undo/Redo are
// disabled (always, on an empty editor); the sunken ground is re-keyed to the wrapper's own
// `data-disabled` (important, so the higher-specificity `has-disabled` rule cannot beat it); and the
// focus outline is extended to the contenteditable, which the base's `input:focus-visible` misses
// (outline only — #613 item 3: no focus-time border colour, one focus line).
const FIELD_GROUP =
  "group h-auto flex-col items-stretch has-disabled:bg-card data-[disabled]:bg-surface-sunken! " +
  "has-[[contenteditable=true]:focus-visible]:outline-[length:var(--border-width-bold)] " +
  "has-[[contenteditable=true]:focus-visible]:outline-solid " +
  "has-[[contenteditable=true]:focus-visible]:outline-ring " +
  "has-[[contenteditable=true]:focus-visible]:outline-offset-2";

/** The character counter appears only from 90% of the limit (or when over it). */
const COUNTER_THRESHOLD = 0.9;

const HEADING_LABEL = { paragraph: "Paragraph", "heading-2": "Section", "heading-3": "Subsection" } as const;
const HEADING_VALUE = { "heading-2": "2", "heading-3": "3", paragraph: "" } as const;

export type QuincyRichTextEditorProps = {
  /** `"composer"`: the compact Project-discussion comment box. `"document"`: the Notice board page editor. */
  preset: RichTextEditorPreset;
  value: RichTextDoc;
  onChange: (value: RichTextDoc) => void;
  // `onChange` carries what each link preview card shows (title, description, site, address, image) beside its id, because whatever a
  // host keeps outside the editor (a draft, an edit in progress) has to redraw the card when the editor is mounted again. The id alone
  // is what is stored, so a host strips with `stripEmbeddedDisplay` at the point it submits and wherever it measures size.
  limit: number;
  /** The stored-JSON cap the surface's server profile enforces (default: the comment cap). */
  maxBytes?: number;
  disabled?: boolean;
  loadMentionables: (query: string) => Promise<MentionableUser[]>;
  placeholder?: string;
  id?: string;
  onSubmit?: () => void;
  /** Turns on embedded images (#493, #496): the toolbar button, paste and drop upload into this Project or the Notice board. A Project also takes video (#494). */
  media?: EmbeddedMediaScope;
  /** Turns on link previews (#497): applying a link asks the server for the page's card and inserts it after the link's block. */
  linkPreviews?: EmbeddedMediaScope;
  /** Reports whether an image is still uploading, so the host can hold Post / Save until it lands. */
  onUploadingChange?: (uploading: boolean) => void;
};

type UploadingMedia = EmbeddedUpload;

/** A file this editor would send down the video path: a Project's discussion only, and by what the file says it is. */
const isVideoFile = (file: Pick<File, "type" | "name">) => file.type.startsWith("video/") || /\.(?:mp4|mov)$/i.test(file.name);

// Marks the transaction that inserts a finished upload, so onUpdate can tell it from the author typing.
const UPLOAD_INSERT_META = "quincyUploadInsert";

export function QuincyRichTextEditor({
  preset,
  value,
  onChange,
  limit,
  maxBytes = RICH_TEXT_JSON_MAX_BYTES,
  disabled = false,
  loadMentionables,
  placeholder = "Write a message…",
  id,
  onSubmit,
  media,
  linkPreviews,
  onUploadingChange,
}: QuincyRichTextEditorProps) {
  const valueRef = useRef(JSON.stringify(value));
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const onSubmitRef = useRef(onSubmit); onSubmitRef.current = onSubmit;
  const limitRef = useRef(limit); limitRef.current = limit;
  const maxBytesRef = useRef(maxBytes); maxBytesRef.current = maxBytes;
  const isDocument = preset === "document";
  const disabledRef = useRef(disabled); disabledRef.current = disabled;
  const editorRef = useRef<Editor | null>(null);
  const menu = useRef<MentionAutocompleteHandle>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const counterRef = useRef<HTMLDivElement>(null);
  const [rawQuery, setQuery] = useState<string | null>(null);
  // #375: Esc / an outside press closes the mention list and it stays closed until the content
  // actually changes; the sheet's layer gate reads the list as open through `aria-expanded`.
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const query = mentionDismissed ? null : rawQuery;
  const [mentionA11y, setMentionA11y] = useState<{ listboxId: string; activeId?: string; expanded: boolean } | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [nestingBlocked, setNestingBlocked] = useState(false);
  // The author cancelled an upload from its tray row: said once in the live region, retired by the next edit. An unmount abort never sets it.
  const [uploadCancelled, setUploadCancelled] = useState(false);
  // A second cancel with no edit between leaves the region's text unchanged, which a screen reader does not announce again: clear it in one
  // committed update and repopulate it in a later one.
  const cancelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearCancelTimer = () => { if (cancelTimer.current !== null) { clearTimeout(cancelTimer.current); cancelTimer.current = null; } };
  useEffect(() => clearCancelTimer, []);
  const announceCancelled = () => { clearCancelTimer(); setUploadCancelled(false); cancelTimer.current = setTimeout(() => { cancelTimer.current = null; setUploadCancelled(true); }, 0); };
  const [deleteTableOpen, setDeleteTableOpen] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const addonRef = useRef<HTMLDivElement>(null);
  const [uploads, setUploads] = useState<UploadingMedia[]>([]);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const uploadSeq = useRef(0);
  const inFlight = useRef(0);
  const mountedRef = useRef(true);
  const mediaRef = useRef(media); mediaRef.current = media;
  const linkPreviewsRef = useRef(linkPreviews); linkPreviewsRef.current = linkPreviews;
  // Bumped when the host replaces the content, so an answer that was in flight for the old content is dropped.
  const contentEpoch = useRef(0);
  const onUploadingChangeRef = useRef(onUploadingChange); onUploadingChangeRef.current = onUploadingChange;
  const addImagesRef = useRef<(files: File[], at?: number, as?: "image" | "video") => void>(() => {});
  // Each running upload's way to stop and to give up its place (the busy count and the tray row), once, whichever of finishing and cancelling comes first.
  // `discard` tells the server to drop a HEIC that was being prepared (a Project has an abort route; the Notice board has none); `retry` re-queues a failed one.
  const running = useRef(new Map<number, { controller: AbortController; release: () => void; discard: () => void; retry: () => void }>());
  // Whether this person may upload HEIC (#495), read through a ref because the upload closure below is reassigned each render.
  const heicEnabled = useEmbeddedHeicEnabled(media !== undefined);
  const heicRef = useRef(heicEnabled); heicRef.current = heicEnabled;
  // Where each running upload will land: captured when it starts and mapped through every later transaction.
  const insertAt = useRef(new Map<number, number>());
  const [picking, setPicking] = useState<{ n: number; kind: "image" | "video" } | null>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const extensions = useMemo(() => [
    ...createRichTextEditorExtensions(preset).map((extension) => extension === LinkPreview ? LinkPreviewWithView : extension === EmbeddedImage ? EmbeddedImageWithView : extension === EmbeddedVideo ? EmbeddedVideoWithView : extension),
    ...(preset === "document" ? [RichTextSlashCommand.configure({ items: [...RICH_TEXT_BASIC_SLASH_ITEMS, RICH_TEXT_TABLE_SLASH_ITEM] })] : []),
  ], [preset]);
  const editor = useEditor({
    extensions,
    // The toolbar subscribes to its own formatting snapshot (`useRichTextState`); the field itself
    // re-renders only on the props and state it owns.
    shouldRerenderOnTransaction: false,
    content: toTiptap(value),
    editable: !disabled,
    editorProps: {
      attributes: { class: "rich-text__editor-content " + EDITOR_CONTENT_UTILITIES + (preset === "document" ? DOCUMENT_CONTENT_UTILITIES : ""), "data-placeholder": placeholder, ...(id ? { id } : {}) },
      // A file dropped or pasted into the editor is ours to handle: letting the browser have it would
      // navigate away from the page (and the unsaved comment) or paste a foreign <img>.
      handlePaste: (_view, event) => {
        if (!mediaRef.current || disabledRef.current) return false;
        const files = Array.from(event.clipboardData?.files ?? []);
        if (!files.length) return false;
        event.preventDefault(); addImagesRef.current(files); return true;
      },
      handleDrop: (view, event) => {
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (!files.length) return false;
        event.preventDefault();
        // The drop lands where it was released, not wherever the selection is by the time the upload finishes.
        if (mediaRef.current && !disabledRef.current) addImagesRef.current(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
        return true;
      },
      handleKeyDown: (view, event) => {
        if (menu.current?.handleKeyDown(event)) return true;
        if (shouldBlockListIndent(event, itemContainerDepth(view.state.selection.$from))) {
          event.preventDefault();
          view.dom.dispatchEvent(new Event("rich-text-nesting-blocked"));
          return true;
        }
        if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
          if (!disabledRef.current && editorRef.current?.can().setLink({ href: "https://example.com" })) {
            event.preventDefault();
            setLinkOpen(true);
            return true;
          }
        }
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          const doc = tiptapToRichTextDoc(view.state.doc.toJSON());
          const plainText = richTextPlainText(doc);
          // Never submit while an image is still uploading: the post would go without it.
          if (inFlight.current > 0) { event.preventDefault(); return true; }
          if (plainText.trim().length > 0 && plainText.length <= limitRef.current && richTextDocByteLength(stripEmbeddedDisplay(doc)) <= maxBytesRef.current && !disabledRef.current) {
            event.preventDefault();
            onSubmitRef.current?.();
            return true;
          }
        }
        return false;
      },
    },
    onUpdate: ({ editor: next, transaction }) => {
      const doc = tiptapToRichTextDoc(next.getJSON(), { keepPreviewDisplay: true });
      const serialised = JSON.stringify(doc);
      // Tiptap/ProseMirror can dispatch a no-op transaction (e.g. from a blur triggered by a
      // submit button click) that reports the same content as before. Propagating it anyway can
      // clobber a concurrent external reset (e.g. the composer clearing after a successful post)
      // that lands between this event and the next render.
      // A card that was shown and is gone now was removed by the author: remember it so a late answer does not bring it back.
      const nowShown = new Set<string>(); next.state.doc.forEach((child) => { if (child.type.name === "linkPreview") nowShown.add(String(child.attrs.url ?? "")); });
      for (const url of shownPreviews.current) if (!nowShown.has(url)) removedPreviews.current.set(url, ++uploadSeq.current);
      shownPreviews.current = nowShown;
      if (serialised === valueRef.current) return;
      valueRef.current = serialised; onChangeRef.current(doc);
      // Only the author's own edits retire an upload problem: a sibling upload landing is not one, and must not hide a problem shown for another file.
      const isUploadInsert = Boolean(transaction.getMeta(UPLOAD_INSERT_META));
      if (!isUploadInsert) setUploadErrors((entries) => (entries.length ? [] : entries));
      // Likewise a sibling upload landing must not retire the cancel announcement or its re-announce timer.
      if (!isUploadInsert) { clearCancelTimer(); setUploadCancelled(false); }
      setNestingBlocked(false); setMentionDismissed(false); setQuery(mentionQuery(next));
    },
    onSelectionUpdate: ({ editor: next }) => setQuery(mentionQuery(next)),
  });
  editorRef.current = editor;
  const state = useRichTextState(editor);
  // Below 721px the table controls are a toolbar group and the floating bar is not mounted; on a desktop the group
  // takes over too when the bar has no room around the table (tier "none": the bar stays mounted but inert) (#535).
  const phone = useMediaQuery(RICH_TEXT_PHONE_QUERY);
  const [reportedTier, setTableTier] = useState<TableBubbleTier | null>(null);
  const tableTier = state.inTable ? reportedTier : null;
  // Which presentation holds the table controls: the floating bar, the desktop Table menu, or the phone's leading group.
  const presentation = phone ? "tools" : tableTier === "none" ? "menu" : "bubble";
  const toolbarRef = useRef(presentation);
  const refocusRef = useRef(false);
  // The presentation holding focus is about to stop being usable: note it while the DOM still shows it (render runs before commit).
  if (toolbarRef.current !== presentation) {
    toolbarRef.current = presentation;
    // Only focus inside THIS editor's own toolbar group or bar counts: another mounted editor must not claim it.
    const active = document.activeElement;
    const own = active?.closest('[data-testid="rich-text-table-tools"], [data-testid="rich-text-table-menu"]') != null && wrapperRef.current?.contains(active) === true
      || (editorRef.current != null && editorOwnsBubbleBar(editorRef.current, active));
    refocusRef.current = own;
  }
  useLayoutEffect(() => {
    if (!refocusRef.current) return;
    refocusRef.current = false;
    if (editorRef.current && !editorRef.current.isDestroyed) editorRef.current.commands.focus();
  }, [presentation]);
  // Leaving the table forgets the tier; the bar's options are rebuilt on entering, so it is reported afresh.
  useEffect(() => { if (!state.inTable) setTableTier(null); }, [state.inTable]);
  // The derived outline rail (document preset only; `null` keeps the composer's selector idle).
  const outline = useRichTextOutline(isDocument ? editor : null);
  const activeHeading = useRichTextActiveHeading(isDocument ? editor : null, pageRef, outline);

  useEffect(() => { if (editor) editor.setEditable(!disabled); }, [disabled, editor]);
  useEffect(() => { if (picking !== null) pickerRef.current?.click(); }, [picking]);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  // Keep every pending insertion point on the text it was beside as the document changes.
  useEffect(() => {
    if (!editor) return;
    const follow = ({ transaction }: { transaction: { docChanged: boolean; mapping: { map: (pos: number) => number } } }) => {
      if (!transaction.docChanged) return;
      for (const [key, pos] of insertAt.current) insertAt.current.set(key, transaction.mapping.map(pos));
    };
    editor.on("transaction", follow);
    return () => { editor.off("transaction", follow); };
  }, [editor]);
  // Each file uploads on its own; its node enters the document only once the server has accepted it, so
  // a failed, cancelled or abandoned upload leaves nothing behind. A video can be cancelled from its tray row, and an
  // upload still running when the editor unmounts is cancelled (the server is told, so no reservation is left).
  addImagesRef.current = (files: File[], at?: number, as?: "image" | "video") => {
    const scope = mediaRef.current;
    const current = editorRef.current;
    if (!scope || !current) return;
    const videos = "projectId" in scope;
    const problems: string[] = [];
    let slots = EMBEDDED_MEDIA_MAX_PER_POST - richTextMediaIds(tiptapToRichTextDoc(current.getJSON())).length - inFlight.current;
    for (const file of files) {
      const kind = as ?? (videos && isVideoFile(file) ? "video" : "image");
      const problem = (kind === "video" ? embeddedVideoProblem(file) : embeddedImageProblem(file, heicRef.current)) ?? (slots <= 0 ? `A post can hold ${EMBEDDED_MEDIA_MAX_PER_POST} ${videos ? "images and videos" : "images"} at most.` : null);
      if (problem) { problems.push(problem); continue; }
      slots -= 1;
      const key = ++uploadSeq.current;
      const controller = new AbortController();
      let released = false; let cancelled = false;
      // A HEIC the server is preparing (#495): its id, so Remove and unmount can abort it, and Retry can ask again. A failed one keeps its row and its place until Remove or a Retry that ends ready.
      let preparedId: string | null = null; let keepRow = false;
      const release = () => {
        if (released) return; released = true;
        insertAt.current.delete(key); running.current.delete(key);
        inFlight.current -= 1;
        // An editor that has unmounted has already told its host it is no longer uploading, and the host may
        // since be running a different editor's uploads: a late callback from this one must not touch that.
        if (!mountedRef.current) return;
        if (inFlight.current === 0) onUploadingChangeRef.current?.(false);
        setUploads((entries) => entries.filter((entry) => entry.key !== key));
      };
      const discard = () => { if (preparedId) void abortEmbeddedImage(scope, preparedId); };
      const setPhase = (phase: "uploading" | "preparing" | "failed") => { if (mountedRef.current && !released) setUploads((entries) => entries.map((entry) => entry.key === key ? { ...entry, phase } : entry)); };
      const onPhase = (phase: "preparing", mediaId: string) => { preparedId = mediaId; setPhase(phase); };
      let posterStored: boolean | undefined;
      const insert = (mediaId: string) => {
        const live = editorRef.current;
        if (cancelled || !mountedRef.current || !live) return;
        const position = Math.min(insertAt.current.get(key) ?? live.state.doc.content.size, live.state.doc.content.size);
        // insertContentAt selects inserted content by default; an async insert must leave the caret where the author is typing.
        live.chain().command(({ tr }) => { tr.setMeta(UPLOAD_INSERT_META, true); return true; }).insertContentAt(position, { type: kind, attrs: kind === "image" ? { mediaId, alt: imageAltFromFileName(file.name) || null } : { mediaId, ...(posterStored === undefined ? {} : { hasPoster: posterStored }) } }, { updateSelection: false }).run();
      };
      const follow = (work: Promise<string>) => {
        keepRow = false;
        void work
          .then(insert)
          .catch((reason) => {
            if (cancelled || (reason instanceof Error && reason.name === "AbortError")) return;
            if (reason instanceof RenditionFailedError) { preparedId = reason.mediaId; keepRow = true; setPhase("failed"); return; }
            if (mountedRef.current) setUploadErrors((entries) => [...entries, `${file.name || (kind === "video" ? "Video" : "Image")} could not be uploaded${reason instanceof Error && reason.message ? `: ${reason.message}` : "."}`]);
          })
          .finally(() => { if (!keepRow) release(); });
      };
      insertAt.current.set(key, at ?? current.state.selection.to);
      inFlight.current += 1; onUploadingChangeRef.current?.(true);
      running.current.set(key, {
        controller,
        release: () => { cancelled = true; controller.abort(); discard(); release(); },
        discard,
        retry: () => { if (!preparedId || released) return; setPhase("preparing"); follow(retryEmbeddedRendition(scope, preparedId, { signal: controller.signal, onPhase })); },
      });
      setUploads((entries) => [...entries, { key, name: file.name || (kind === "video" ? "Video" : "Image"), percent: 0, kind }]);
      const onProgress = (percent: number) => { if (mountedRef.current && !released) setUploads((entries) => entries.map((entry) => entry.key === key ? { ...entry, percent } : entry)); };
      follow(kind === "video" && "projectId" in scope ? uploadEmbeddedVideo(scope.projectId, file, { signal: controller.signal, onProgress, onPoster: (stored) => { posterStored = stored; } }) : uploadEmbeddedImage(scope, file, onProgress, { signal: controller.signal, onPhase }));
    }
    setUploadErrors(problems);
  };
  // A link was just applied: ask for its card and put it after the link's top-level block. The place is carried through later
  // edits like an upload's, and a late answer (the content was replaced, the editor unmounted, three cards already, the same address
  // already carded) is dropped. No card, a refusal or a failure all leave the link a link.
  const hasLink = (doc: { descendants: (callback: (child: { marks: ReadonlyArray<{ type: { name: string }; attrs: Record<string, unknown> }> }) => boolean | void) => void }, href: string) => {
    let found = false;
    doc.descendants((child) => { if (child.marks.some((mark) => mark.type.name === "link" && mark.attrs.href === href)) found = true; return !found; });
    return found;
  };
  const hasPreviewId = (doc: { forEach: (callback: (child: { type: { name: string }; attrs: Record<string, unknown> }) => void) => void }, previewId: string) => {
    let found = false; doc.forEach((child) => { if (child.type.name === "linkPreview" && child.attrs.previewId === previewId) found = true; }); return found;
  };
  const previewControllers = useRef(new Set<AbortController>());
  // One request per address at a time, and the addresses whose card the author removed (with when), so a late answer cannot put it back.
  const pendingPreviews = useRef(new Set<string>());
  const removedPreviews = useRef(new Map<string, number>());
  const shownPreviews = useRef(new Set<string>());
  const offerLinkPreview = (href: string) => {
    const scope = linkPreviewsRef.current; const current = editorRef.current;
    if (!scope || !current || disabledRef.current) return;
    const cards = () => { const found: string[] = []; current.state.doc.forEach((child) => { if (child.type.name === "linkPreview") found.push(String(child.attrs.url ?? "")); }); return found; };
    if (cards().length >= RICH_TEXT_MAX_LINK_PREVIEWS || cards().includes(href) || pendingPreviews.current.has(href)) return;
    const pending = pendingPreviews.current; pending.add(href);
    const key = ++uploadSeq.current; const epoch = contentEpoch.current;
    const { $to } = current.state.selection;
    insertAt.current.set(key, $to.depth >= 1 ? $to.after(1) : $to.pos);
    const controller = new AbortController(); previewControllers.current.add(controller);
    void requestLinkPreview(scope, href, controller.signal).then((card) => {
      const live = editorRef.current;
      if (!card || controller.signal.aborted || !mountedRef.current || !live || epoch !== contentEpoch.current) return;
      // The link may have been undone or replaced while the page was fetched: the card belongs to a link that is still there.
      if (!hasLink(live.state.doc, href)) return;
      if ((removedPreviews.current.get(card.url) ?? 0) > key || (removedPreviews.current.get(href) ?? 0) > key) return;
      if (cards().length >= RICH_TEXT_MAX_LINK_PREVIEWS || cards().includes(card.url) || hasPreviewId(live.state.doc, card.previewId)) return;
      const size = live.state.doc.content.size;
      const mapped = Math.min(insertAt.current.get(key) ?? size, size);
      const $at = live.state.doc.resolve(mapped);
      // insertContentAt selects inserted content by default: the arriving card must not take the author's selection, or the next keystroke deletes it.
      live.chain().insertContentAt($at.depth >= 1 ? $at.after(1) : mapped, { type: "linkPreview", attrs: card }, { updateSelection: false }).run();
    }).catch(() => undefined).finally(() => { pending.delete(href); insertAt.current.delete(key); previewControllers.current.delete(controller); });
  };
  useEffect(() => () => { for (const controller of previewControllers.current) controller.abort(); }, []);
  useEffect(() => () => {
    for (const entry of [...running.current.values()]) { entry.controller.abort(); entry.discard(); }
    if (inFlight.current > 0) onUploadingChangeRef.current?.(false);
  }, []);
  // A video can take minutes: leaving the page would lose it, so the browser is asked to confirm. Images are over too fast to warn about.
  const uploadingVideo = uploads.some((entry) => entry.kind === "video");
  useEffect(() => {
    if (!uploadingVideo) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploadingVideo]);
  useEffect(() => {
    if (query === null) return;
    // Bubble phase on purpose: the Project sheet snapshots "is a layer open" at window-capture,
    // which must still see this list open for the very press that dismisses it.
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && wrapperRef.current?.contains(event.target)) return;
      setMentionDismissed(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [query]);
  // Esc is only seen by the editor's key handler, so a list left open behind a Tab would hold the
  // sheet's layer gate shut for good: close it when focus leaves the editor.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onBlur = () => {
      setMentionDismissed(true);
      // The slash menu only exists on the document preset; the other preset has no such plugin state.
      if (RICH_TEXT_SLASH_KEY.getState(editor.view.state)) exitSuggestion(editor.view, RICH_TEXT_SLASH_KEY);
    };
    dom.addEventListener("blur", onBlur);
    return () => dom.removeEventListener("blur", onBlur);
  }, [editor]);
  // The stuck composer toolbar (#594) covers the top of the viewport, which ProseMirror's scroll-into-view knows nothing of: a caret
  // moved up (ArrowUp, typing at the top edge) could land under it. `scrollMargin.top` and `scrollThreshold.top` (a caret is only scrolled once within the threshold of the edge) are its bottom: its sticky `top` (header and
  // impersonation offset included, read from the computed style) plus its height. Constant, so it does not depend on being stuck now.
  useEffect(() => {
    const addon = addonRef.current;
    if (!editor || !isDocument || !addon) return;
    const apply = () => {
      const style = getComputedStyle(addon);
      const top = (parseFloat(style.top) || 0) + addon.offsetHeight;
      // Breathing room under the toolbar: `--space-2`, read as a length (rem or px), 8px when unreadable.
      const token = style.getPropertyValue("--space-2").trim();
      const gap = token.endsWith("rem") ? parseFloat(token) * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) : token.endsWith("px") ? parseFloat(token) : 8;
      // The toolbar's block size, for headings' scroll-margin (an outline jump must land clear of it).
      wrapperRef.current?.style.setProperty("--rich-text-toolbar-block", `${addon.offsetHeight}px`);
      editor.view.setProps({ scrollMargin: { top: top + gap, right: 5, bottom: 5, left: 5 }, scrollThreshold: { top, right: 0, bottom: 0, left: 0 } });
    };
    apply();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    observer?.observe(addon);
    window.addEventListener("resize", apply);
    editor.view.dom.addEventListener("focus", apply);
    return () => { observer?.disconnect(); window.removeEventListener("resize", apply); editor.view.dom.removeEventListener("focus", apply); };
  }, [editor, isDocument]);
  useEffect(() => {
    if (!editor) return;
    const announce = () => setNestingBlocked(true);
    editor.view.dom.addEventListener("rich-text-nesting-blocked", announce);
    return () => editor.view.dom.removeEventListener("rich-text-nesting-blocked", announce);
  }, [editor]);
  useEffect(() => {
    if (!editor) return;
    const serialised = JSON.stringify(value);
    if (serialised !== valueRef.current) {
      // The host replaced the content (a post cleared the composer, or an edit began): an earlier upload error is stale.
      setUploadErrors((entries) => (entries.length ? [] : entries));
      contentEpoch.current += 1; shownPreviews.current = new Set(); removedPreviews.current = new Map(); pendingPreviews.current = new Set();
      const applied = editor.commands.setContent(toTiptap(value), { emitUpdate: false });
      if (applied && JSON.stringify(tiptapToRichTextDoc(editor.getJSON(), { keepPreviewDisplay: true })) === serialised) valueRef.current = serialised;
    }
  }, [editor, value]);
  useEffect(() => {
    if (!editor || !mentionA11y) return;
    const dom = editor.view.dom;
    dom.setAttribute("role", "combobox");
    dom.setAttribute("aria-haspopup", "listbox");
    dom.setAttribute("aria-expanded", String(mentionA11y.expanded));
    dom.setAttribute("aria-controls", mentionA11y.listboxId);
    if (mentionA11y.activeId) dom.setAttribute("aria-activedescendant", mentionA11y.activeId);
    else dom.removeAttribute("aria-activedescendant");
  }, [editor, mentionA11y]);
  if (!editor) return null;

  const plainText = richTextPlainText(value);
  const overBytes = richTextDocByteLength(stripEmbeddedDisplay(value)) > maxBytes;
  const selectMention = (user: MentionableUser) => {
    const activeQuery = query ?? "";
    const from = editor.state.selection.from - activeQuery.length - 1;
    editor.chain().focus().insertContentAt({ from, to: editor.state.selection.from }, { type: "mention", attrs: { id: user.id, label: user.name } }).insertContent(" ").run();
    setQuery(null);
  };
  const setBlock = (next: string) => {
    if (disabled || !state.canHeading) return;
    if (next === "2" || next === "3") editor.chain().focus().toggleHeading({ level: Number(next) as 2 | 3 }).run();
    else editor.chain().focus().setParagraph().run();
  };
  // The picker is mounted only while a choice is being made: a standing file input would be a second upload control on
  // every Project surface that renders the composer. It is the installed ReUI `Input`, clicked as soon as it mounts.
  const choose = (kind: "image" | "video") => setPicking((previous) => ({ n: (previous?.n ?? 0) + 1, kind }));
  // The live region stays mounted so screen readers announce a message when it appears, but it takes no space while empty.
  const CANCELLED_MESSAGE = "Upload cancelled";
  const liveMessage = overBytes ? "This formatting is too large to save; remove list items or formatting." : nestingBlocked ? "Maximum list nesting is four levels" : uploadCancelled ? CANCELLED_MESSAGE : "";
  const off = (can: boolean) => disabled || !can;

  return <div ref={wrapperRef} className="group grid gap-[var(--space-2)]" data-disabled={disabled || undefined}>
    <InputGroup data-testid="rich-text-field" className={FIELD_GROUP} data-disabled={disabled || undefined}>
      <InputGroupAddon ref={addonRef} align="block-start" className={cn("p-[var(--space-1)] cursor-default", isDocument && "rich-text-toolbar-sticky")}>
        <RichTextToolbar aria-label="Formatting" className="w-full min-w-0 gap-[var(--space-2)]">
          {/* On a phone the table controls lead the scrolling toolbar; they stay while the editor is busy, disabled. On a desktop they are the Table menu in the Insert-table slot (#595). */}
          {isDocument && phone && state.inTable && <RichTextTableTools editor={editor} onDeleteTable={() => setDeleteTableOpen(true)} disabled={disabled || !state.editable} />}
          <RichTextToolbarGroup label="Text style">
            <RichTextToggle label="Bold" shortcut={["mod", "B"]} pressed={state.bold} disabled={off(state.canBold)} onToggle={() => editor.chain().focus().toggleBold().run()}><span aria-hidden="true" className="font-bold">B</span></RichTextToggle>
            <RichTextToggle label="Italic" shortcut={["mod", "I"]} pressed={state.italic} disabled={off(state.canItalic)} onToggle={() => editor.chain().focus().toggleItalic().run()}><span aria-hidden="true" className="italic">I</span></RichTextToggle>
            <RichTextToggle label="Underline" shortcut={["mod", "U"]} pressed={state.underline} disabled={off(state.canUnderline)} onToggle={() => editor.chain().focus().toggleUnderline().run()}><span aria-hidden="true" className="underline">U</span></RichTextToggle>
            <RichTextToggle label="Strikethrough" pressed={state.strike} disabled={off(state.canStrike)} onToggle={() => editor.chain().focus().toggleStrike().run()}><span aria-hidden="true" className="line-through">S</span></RichTextToggle>
          </RichTextToolbarGroup>
          <RichTextToolbarSeparator />
          <RichTextToolbarGroup label="Blocks">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="sm" aria-label="Heading" disabled={off(state.canHeading)} data-toolbar-item="" data-testid="rich-text-heading-menu" className="min-w-[8.5rem] justify-between max-[721px]:h-11" />}
              >
                {HEADING_LABEL[state.blockType]}
                <ChevronDownIcon aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuRadioGroup value={HEADING_VALUE[state.blockType]} onValueChange={(next) => setBlock(String(next))}>
                  <DropdownMenuRadioItem value="">Paragraph</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="2">Section</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="3">Subsection</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <RichTextLinkPopover editor={editor} state={state} disabled={disabled} testId="rich-text-link-popover" open={linkOpen} onOpenChange={setLinkOpen} onApplied={offerLinkPreview} />
            <RichTextToggle label="Bullet list" pressed={state.bulletList} disabled={off(state.canBulletList) || state.atListNestingLimit} onToggle={() => editor.chain().focus().toggleBulletList().run()}><ListIcon aria-hidden="true" /></RichTextToggle>
            <RichTextToggle label="Ordered list" pressed={state.orderedList} disabled={off(state.canOrderedList) || state.atListNestingLimit} onToggle={() => editor.chain().focus().toggleOrderedList().run()}><ListOrderedIcon aria-hidden="true" /></RichTextToggle>
            <RichTextToggle label="Checklist" pressed={state.taskList} disabled={off(state.canTaskList) || state.atListNestingLimit} onToggle={() => editor.chain().focus().toggleTaskList().run()}><ListChecksIcon aria-hidden="true" /></RichTextToggle>
          </RichTextToolbarGroup>
          {isDocument && <>
            <RichTextToolbarSeparator />
            <RichTextToolbarGroup label="Layout">
              <RichTextAlignMenu editor={editor} state={state} disabled={disabled} />
              <RichTextHighlightPopover editor={editor} state={state} />
              {!phone && tableTier === "none"
                ? <RichTextTableMenu editor={editor} onDeleteTable={() => setDeleteTableOpen(true)} disabled={disabled || !state.editable} />
                : <RichTextButton label="Insert table" disabled={off(state.canInsertTable)} onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><TableIcon aria-hidden="true" /></RichTextButton>}
            </RichTextToolbarGroup>
          </>}
          {/* On a phone the toolbar scrolls sideways, which would leave Insert image off-screen: there it comes first (reversed, so the separator follows it). */}
          {media && <div data-testid="rich-text-media-tools" className="flex shrink-0 items-center gap-[var(--space-2)] max-[721px]:order-first max-[721px]:flex-row-reverse">
            <RichTextToolbarSeparator />
            <RichTextToolbarGroup label="Media">
              <RichTextButton label="Insert image" disabled={disabled} onClick={() => choose("image")}><ImageIcon aria-hidden="true" /></RichTextButton>
              {"projectId" in media && <RichTextButton label="Insert video" disabled={disabled} onClick={() => choose("video")}><VideoIcon aria-hidden="true" /></RichTextButton>}
            </RichTextToolbarGroup>
          </div>}
          <RichTextToolbarSeparator />
          <RichTextToolbarGroup label="History">
            <RichTextButton label="Undo" shortcut={["mod", "Z"]} disabled={off(state.canUndo)} onClick={() => editor.chain().focus().undo().run()}><Undo2Icon aria-hidden="true" /></RichTextButton>
            <RichTextButton label="Redo" shortcut={["mod", "shift", "Z"]} disabled={off(state.canRedo)} onClick={() => editor.chain().focus().redo().run()}><Redo2Icon aria-hidden="true" /></RichTextButton>
          </RichTextToolbarGroup>
        </RichTextToolbar>
      </InputGroupAddon>
      <div ref={pageRef} className="relative w-full min-w-0">
        <EditorContent editor={editor} className="w-full min-w-0" />
        {isDocument && outline.length >= 2 && <RichTextOutlineRail outline={outline} activeIndex={activeHeading} onSelect={(index) => scrollToRichTextHeading(editor, index)} className="absolute end-1 top-2 z-[1] max-[721px]:hidden" />}
      </div>
    </InputGroup>
    {isDocument && <>
      {!phone && <RichTextTableBubble editor={editor} onDeleteTable={() => setDeleteTableOpen(true)} tier={tableTier} onTierChange={setTableTier} ceiling={() => addonRef.current?.getBoundingClientRect().bottom ?? 0} />}
      <DeleteTableDialog editor={editor} open={deleteTableOpen} onOpenChange={setDeleteTableOpen} />
    </>}
    {picking !== null && <Input
      key={picking.n} ref={pickerRef} type="file" multiple accept={picking.kind === "video" ? EMBEDDED_VIDEO_ACCEPT : embeddedImageAccept(heicEnabled)} tabIndex={-1} aria-hidden="true" aria-label={picking.kind === "video" ? "Choose videos" : "Choose images"} data-testid={picking.kind === "video" ? "rich-text-video-picker" : "rich-text-image-picker"} className="sr-only"
      onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); const kind = picking.kind; setPicking(null); if (files.length) addImagesRef.current(files, editor.state.selection.to, kind); }}
      {...{ onCancel: () => setPicking(null) }}
    />}
    <EmbeddedUploadTray uploads={uploads} errors={uploadErrors} onCancel={(key) => { running.current.get(key)?.release(); announceCancelled(); editorRef.current?.commands.focus(); }} onRemove={(key) => { running.current.get(key)?.release(); editorRef.current?.commands.focus(); }} onRetry={(key) => running.current.get(key)?.retry()} />
    <MentionAutocomplete ref={menu} query={query} loadMentionables={loadMentionables} onSelect={selectMention} onDismiss={() => setMentionDismissed(true)} onAccessibilityChange={setMentionA11y} />
    {plainText.length >= limit * COUNTER_THRESHOLD && <div ref={counterRef} data-testid="rich-text-counter" className={cn("text-right [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary", plainText.length > limit && "!text-destructive")}>{plainText.length}/{limit}</div>}
    <div className={liveMessage && liveMessage !== CANCELLED_MESSAGE ? "[font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-destructive" : "sr-only"} aria-live="polite">{liveMessage}</div>
  </div>;
}
