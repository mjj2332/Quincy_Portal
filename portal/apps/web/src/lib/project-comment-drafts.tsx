import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { RichTextDoc } from "@quincy/shared";

/**
 * Unsent Project comments, kept per Project while the signed-in session lives (#375).
 *
 * Memory only, and mounted INSIDE the principal-keyed `QuincyQueryProvider` in `App.tsx`: sign-out
 * unmounts the tree and an impersonation start/stop changes the key, so the provider — and every
 * draft in it — is dropped with the principal. No storage, no module singleton, nothing that can
 * outlive the user. A page reload discards drafts (deliberately: storage is a cross-user surface).
 *
 * Only the new-comment composer participates; edit-in-place is out of scope.
 */
type DraftStore = {
  get(projectId: string): RichTextDoc | undefined;
  set(projectId: string, doc: RichTextDoc): void;
  /** Drops the draft only if it still equals `doc` (a newer draft must survive a slow post). */
  clearIf(projectId: string, doc: RichTextDoc): void;
};

const DraftsContext = createContext<DraftStore | null>(null);

const emptyDoc = (): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph" }] });
const isEmptyDoc = (doc: RichTextDoc) => JSON.stringify(doc) === JSON.stringify(emptyDoc());

export function ProjectCommentDraftsProvider({ children }: { children: ReactNode }) {
  const drafts = useRef(new Map<string, RichTextDoc>());
  const store = useMemo<DraftStore>(() => ({
    get: (projectId) => drafts.current.get(projectId),
    set: (projectId, doc) => { if (isEmptyDoc(doc)) drafts.current.delete(projectId); else drafts.current.set(projectId, doc); },
    clearIf: (projectId, doc) => {
      const stored = drafts.current.get(projectId);
      if (stored && JSON.stringify(stored) === JSON.stringify(doc)) drafts.current.delete(projectId);
    },
  }), []);
  return <DraftsContext.Provider value={store}>{children}</DraftsContext.Provider>;
}

/** `[content, setContent, clearIfSubmitted]`; plain local state when no provider is mounted. */
export function useProjectCommentDraft(projectId: string): [RichTextDoc, (doc: RichTextDoc) => void, (submitted: RichTextDoc) => void] {
  const store = useContext(DraftsContext);
  const [state, setState] = useState<{ projectId: string; content: RichTextDoc }>(() => ({ projectId, content: store?.get(projectId) ?? emptyDoc() }));
  // The thread is not always keyed per Project: re-read the store when the Project changes.
  useEffect(() => {
    setState((current) => current.projectId === projectId ? current : { projectId, content: store?.get(projectId) ?? emptyDoc() });
  }, [projectId, store]);
  const content = state.projectId === projectId ? state.content : (store?.get(projectId) ?? emptyDoc());
  const setContent = useCallback((doc: RichTextDoc) => {
    store?.set(projectId, doc);
    setState({ projectId, content: doc });
  }, [projectId, store]);
  const clearIfSubmitted = useCallback((submitted: RichTextDoc) => { store?.clearIf(projectId, submitted); }, [projectId, store]);
  return [content, setContent, clearIfSubmitted];
}
