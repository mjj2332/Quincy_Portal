import { lazy, Suspense, type ComponentProps } from "react";

// The editor (Tiptap and the toolbar) is the heaviest thing on the page and a guest who only reads never needs it: it is its own chunk, fetched when a form first opens.
const Editor = lazy(() => import("./GuestNoteEditor").then((module) => ({ default: module.GuestNoteEditor })));

/** `GuestNoteEditor`, loaded on demand. The place holds the field's room while the chunk comes, so the form does not jump. */
export function GuestNoteField(props: ComponentProps<typeof Editor>) {
  return <Suspense fallback={<p data-testid={`${props.testId}-loading`} aria-busy="true" className="m-0 min-h-[var(--space-8)] text-foreground-secondary [font:var(--type-body-sm)]">Loading the note field…</p>}>
    <Editor {...props} />
  </Suspense>;
}
