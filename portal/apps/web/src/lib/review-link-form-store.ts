import { classifyReviewLinkError, type ReviewLinkErrorAction } from "./review-link-errors";

/**
 * Everything a person is in the middle of on Review links (#741 11b), for as long as the Video tab is open: the Videos ticked for a new
 * link, the create form, each link's unsaved edits, which dialog step is showing, the one-time URL and every request that is out. One store
 * per person + Project, created by the collection and retired when either changes, never a component's state: the dialog, its steps and
 * the panel all remount (a tab switch, a refetch swapping the list, Escape) and none of that may lose a half-typed passcode, a
 * selection, or the only copy of a link. A request addresses its scope (`create`, `patch:<link>`, ...) and the op that started it: a
 * completion applies only while that op still owns the scope. Closing the dialog does NOT cancel a request: a create that lands after
 * Escape still shows its URL. Imports the error classifier only; the writes are handed in (`run`).
 * The URL is held in memory for the reveal step and nowhere else: never storage, never a query cache.
 * See docs/lessons.md "Form lifetime is not component lifetime".
 */
export type Allow = { comments: boolean; approve: boolean; download: boolean };
export const DEFAULT_ALLOW: Readonly<Allow> = Object.freeze({ comments: true, approve: true, download: true });

/** `expiryDay` null is "the default" (30 days out), resolved when the form renders and when it is sent; `grants` holds only the Videos the person changed (a Video left out is granted its current Version). */
export type CreateDraft = { label: string; passcode: string; expiryDay: string | null; allow: Allow; grants: Readonly<Record<string, readonly string[]>> };
/** An edit of one link: `null` / `{}` mean untouched. `removePasscode` and a typed `passcode` are exclusive. */
export type DetailDraft = { label: string | null; expiryDay: string | null; passcode: string; removePasscode: boolean; allow: Partial<Allow> };
export type Reveal = { url: string; linkId: string; label: string | null; origin: "create" | "replace" };
export type ReviewLinkView = { kind: "closed" } | { kind: "list" } | { kind: "create" } | { kind: "detail"; linkId: string } | { kind: "reveal" };
export type Problem = { text: string; action: ReviewLinkErrorAction };

export type ReviewLinkStoreState = {
  selection: ReadonlySet<string>;
  view: ReviewLinkView;
  create: CreateDraft;
  details: Readonly<Record<string, DetailDraft>>;
  reveal: Reveal | null;
  /** Scopes with a request out. */
  pending: ReadonlySet<string>;
  /** The last refusal per scope. */
  problems: Readonly<Record<string, Problem>>;
};

const emptyCreate = (): CreateDraft => ({ label: "", passcode: "", expiryDay: null, allow: { ...DEFAULT_ALLOW }, grants: {} });
export const emptyDetail = (): DetailDraft => ({ label: null, expiryDay: null, passcode: "", removePasscode: false, allow: {} });
const initial = (): ReviewLinkStoreState => ({ selection: new Set(), view: { kind: "closed" }, create: emptyCreate(), details: {}, reveal: null, pending: new Set(), problems: {} });

export type ReviewLinkStore = ReturnType<typeof createReviewLinkStore>;

export function createReviewLinkStore(key: string) {
  let state = initial();
  let dead = false;
  let nextOp = 1;
  /** The op that owns each scope. */
  const owner = new Map<string, number>();
  const listeners = new Set<() => void>();
  const set = (next: ReviewLinkStoreState) => { if (dead) return; state = next; for (const listener of [...listeners]) listener(); };
  const update = (change: (current: ReviewLinkStoreState) => Partial<ReviewLinkStoreState>) => set({ ...state, ...change(state) });
  const without = <T,>(record: Readonly<Record<string, T>>, name: string): Record<string, T> => { const { [name]: _gone, ...rest } = record; return rest; };

  function reset() { owner.clear(); set(initial()); }

  return {
    key,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getState: () => state,

    toggleSelect(videoId: string) { update((s) => { const selection = new Set(s.selection); if (!selection.delete(videoId)) selection.add(videoId); return { selection }; }); },
    clearSelection() { update(() => ({ selection: new Set() })); },
    /** Drops ticks for Videos that are no longer in the Project. */
    pruneSelection(existing: Iterable<string>) {
      const live = new Set(existing);
      if ([...state.selection].every((id) => live.has(id))) return;
      update((s) => ({ selection: new Set([...s.selection].filter((id) => live.has(id))) }));
    },

    openList() { update(() => ({ view: { kind: "list" } })); },
    openCreate() { update(() => ({ view: { kind: "create" } })); },
    openDetail(linkId: string) { update(() => ({ view: { kind: "detail", linkId } })); },
    /** Closing never cancels a request and never discards a draft; it does discard the one-time URL. */
    closeDialog() { update(() => ({ view: { kind: "closed" }, reveal: null })); },

    patchCreate(change: Partial<Omit<CreateDraft, "grants">>) { update((s) => ({ create: { ...s.create, ...change } })); },
    setGrant(videoId: string, assetIds: readonly string[]) { update((s) => ({ create: { ...s.create, grants: { ...s.create.grants, [videoId]: assetIds } } })); },
    patchDetail(linkId: string, change: Partial<DetailDraft>) { update((s) => ({ details: { ...s.details, [linkId]: { ...(s.details[linkId] ?? emptyDetail()), ...change } } })); },
    resetDetail(linkId: string) { update((s) => ({ details: without(s.details, linkId) })); },

    /** The create or replace answered: show the URL once. A created link also clears what it was made from. */
    showReveal(reveal: Reveal) {
      update((s) => ({ reveal, view: { kind: "reveal" }, ...(reveal.origin === "create" ? { selection: new Set<string>(), create: emptyCreate() } : {}), details: s.details }));
    },
    dismissReveal() {
      const linkId = state.reveal?.linkId;
      update(() => ({ reveal: null, view: linkId ? { kind: "detail", linkId } : { kind: "list" } }));
    },

    clearProblem(scope: string) { if (state.problems[scope]) update((s) => ({ problems: without(s.problems, scope) })); },

    /**
     * Sends one request for `scope`. Refused (false) while that scope already has one out. `ok` runs only if this op still owns the scope
     * (nothing cancelled or retired it meanwhile); a failure leaves a classified problem on the scope. Resolves to whether it succeeded.
     */
    async run<T>(scope: string, task: () => Promise<T>, ok: (result: T) => void, onFail?: (problem: Problem) => void): Promise<boolean> {
      if (dead || owner.has(scope)) return false;
      const op = nextOp++;
      owner.set(scope, op);
      update((s) => ({ pending: new Set(s.pending).add(scope), problems: without(s.problems, scope) }));
      const settle = () => { owner.delete(scope); update((s) => { const pending = new Set(s.pending); pending.delete(scope); return { pending }; }); };
      try {
        const result = await task();
        if (owner.get(scope) !== op) return false;
        settle(); ok(result);
        return true;
      } catch (error) {
        if (owner.get(scope) !== op) return false;
        const classified = classifyReviewLinkError(error);
        const problem: Problem = { text: classified.text, action: classified.action };
        settle();
        update((s) => ({ problems: { ...s.problems, [scope]: problem } }));
        onFail?.(problem);
        return false;
      }
    },

    /** The person changed or signed out: nothing in flight may write again, and nothing they typed or were shown stays. */
    cancelAll() { reset(); },
    retire() { reset(); dead = true; listeners.clear(); },
  };
}
