// Vendored from ReUI `rich-text-editor-2` (`rich-text-state.ts`) via the `tmp/ReUI-Test-1` sandbox
// (#491). The snapshot is trimmed to what the Quincy composer's schema can express, because the
// vendor's selectors call commands Quincy's schema removed:
// - `can().toggleCode()` throws (`code: false` removes the command), and `setHeading({ level: 1 })`
//   is always false with levels [2, 3]: `canHeading` asks for level 2.
// - code, blockquote, codeBlock, align, highlight and the word/character count
//   (`storage.characterCount` is undefined here) are dropped; the 90% counter stays Quincy's.
// Added: per-command `can*` flags (the legacy toolbar disabled each control on its own `can()`),
// and `atListNestingLimit` (four item containers, the server's depth cap).
import { useEditorState, type Editor } from "@tiptap/react";
import { RICH_TEXT_MAX_ITEM_CONTAINER_LEVELS, itemContainerDepth } from "@/lib/rich-text-tiptap";

export type RichTextBlockType = "paragraph" | "heading-2" | "heading-3";

export interface RichTextSnapshot {
  editable: boolean;
  blockType: RichTextBlockType;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  bulletList: boolean;
  orderedList: boolean;
  taskList: boolean;
  link: string | null;
  canBold: boolean;
  canItalic: boolean;
  canUnderline: boolean;
  canStrike: boolean;
  canLink: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canBulletList: boolean;
  canOrderedList: boolean;
  canTaskList: boolean;
  /** A heading is refused inside list and task items. */
  canHeading: boolean;
  /** Four item containers is the server's depth cap: a fifth list would be rejected on save. */
  atListNestingLimit: boolean;
}

const IDLE_SNAPSHOT: RichTextSnapshot = {
  editable: false,
  blockType: "paragraph",
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  bulletList: false,
  orderedList: false,
  taskList: false,
  link: null,
  canBold: false,
  canItalic: false,
  canUnderline: false,
  canStrike: false,
  canLink: false,
  canUndo: false,
  canRedo: false,
  canBulletList: false,
  canOrderedList: false,
  canTaskList: false,
  canHeading: false,
  atListNestingLimit: false,
};

function readBlockType(editor: Editor): RichTextBlockType {
  if (editor.isActive("heading", { level: 2 })) return "heading-2";
  if (editor.isActive("heading", { level: 3 })) return "heading-3";
  return "paragraph";
}

function readSnapshot(editor: Editor | null): RichTextSnapshot {
  if (!editor) return IDLE_SNAPSHOT;
  const editable = editor.isEditable;
  const href = editor.isActive("link") ? (editor.getAttributes("link").href as unknown) : null;
  return {
    editable,
    blockType: readBlockType(editor),
    bold: editor.isActive("bold"),
    italic: editor.isActive("italic"),
    underline: editor.isActive("underline"),
    strike: editor.isActive("strike"),
    bulletList: editor.isActive("bulletList"),
    orderedList: editor.isActive("orderedList"),
    taskList: editor.isActive("taskList"),
    link: typeof href === "string" ? href : null,
    canBold: editable && editor.can().toggleBold(),
    canItalic: editable && editor.can().toggleItalic(),
    canUnderline: editable && editor.can().toggleUnderline(),
    canStrike: editable && editor.can().toggleStrike(),
    canLink: editable && editor.can().setLink({ href: "https://example.com" }),
    canUndo: editable && editor.can().undo(),
    canRedo: editable && editor.can().redo(),
    canBulletList: editable && editor.can().toggleBulletList(),
    canOrderedList: editable && editor.can().toggleOrderedList(),
    canTaskList: editable && editor.can().toggleTaskList(),
    canHeading: editable && (editor.can().toggleHeading({ level: 2 }) || editor.can().toggleHeading({ level: 3 })),
    atListNestingLimit: itemContainerDepth(editor.state.selection.$from) >= RICH_TEXT_MAX_ITEM_CONTAINER_LEVELS,
  };
}

// Tiptap's snapshot keeps a null editor until the first transaction after mount,
// so every selector falls back to the instance it was handed.
export function useRichTextSelector<T>(editor: Editor | null, select: (editor: Editor | null) => T) {
  return useEditorState({
    editor,
    selector: ({ editor: current }) => select(current ?? editor),
  }) as T;
}

/** One formatting snapshot per transaction, compared deeply, for the toolbar. */
export function useRichTextState(editor: Editor | null) {
  return useRichTextSelector(editor, readSnapshot);
}
