import { lazy, Suspense, type ComponentProps, type ReactNode } from "react";

// The editor (Tiptap and the toolbar) is the heaviest thing on the page and a guest who only reads never needs it: it is its own chunk, fetched when a form first opens
// (on a phone, when the video screen mounts for a writer: the pill holds the field at rest, #879 PR 2).
const load = () => import("./GuestNoteEditor");
const Editor = lazy(() => load().then((module) => ({ default: module.GuestNoteEditor })));

/** Starts fetching the editor's chunk ahead of the field (an unverified guest's tap on the pill's shell, #879 PR 2), so it is there by the time the code is in. */
export function preloadGuestNoteEditor(): void { void load(); }

/**
 * `GuestNoteEditor`, loaded on demand. The place holds the field's room while the chunk comes, so the form does not jump; `fallback` replaces that placeholder (the phone pill
 * passes its own same-size shell).
 */
export function GuestNoteField({ fallback, ...props }: ComponentProps<typeof Editor> & { fallback?: ReactNode }) {
  return <Suspense fallback={fallback ?? <p data-testid={`${props.testId}-loading`} aria-busy="true" className="m-0 min-h-[var(--space-8)] text-foreground-secondary [font:var(--type-body-sm)]">Loading the note field…</p>}>
    <Editor {...props} />
  </Suspense>;
}
