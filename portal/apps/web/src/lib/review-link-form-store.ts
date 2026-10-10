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
  /** The one-time URLs waiting to be read, oldest first; none is ever replaced, each goes only when dismissed. */
  reveals: readonly Reveal[];
  /** The one on screen: `reveals[0]`. */
  reveal: Reveal | null;
  /** Scopes with a request out. */
  pending: ReadonlySet<string>;
  /** The last refusal per scope. */
  problems: Readonly<Record<string, Problem>>;
};

const emptyCreate = (): CreateDraft => ({ label: "", passcode: "", expiryDay: null, allow: { ...DEFAULT_ALLOW }, grants: {} });
export const emptyDetail = (): DetailDraft => ({ label: null, expiryDay: null, passcode: "", removePasscode: false, allow: {} });
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);
const queued = (reveals: readonly Reveal[]): Pick<ReviewLinkStoreState, "reveals" | "reveal"> => ({ reveals, reveal: reveals[0] ?? null });
const initial = (): ReviewLinkStoreState => ({ selection: new Set(), view: { kind: "closed" }, create: emptyCreate(), details: {}, reveals: [], reveal: null, pending: new Set(), problems: {} });

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
    /** Closing never cancels a request and never discards a draft; it does discard the one-time URL on screen. */
    closeDialog() {
      update((s) => {
        // On a reveal, closing dismisses the URL on screen and nothing else: a second one waiting is still unread.
        if (s.view.kind === "reveal" && s.reveals.length > 1) return queued(s.reveals.slice(1));
        return { view: { kind: "closed" }, ...queued([]) };
      });
    },

    patchCreate(change: Partial<Omit<CreateDraft, "grants">>) { update((s) => ({ create: { ...s.create, ...change } })); },
    setGrant(videoId: string, assetIds: readonly string[]) { update((s) => ({ create: { ...s.create, grants: { ...s.create.grants, [videoId]: assetIds } } })); },
    patchDetail(linkId: string, change: Partial<DetailDraft>) { update((s) => ({ details: { ...s.details, [linkId]: { ...(s.details[linkId] ?? emptyDetail()), ...change } } })); },
    /** A save answered: clear the fields that were sent (as `submitted` held them) and keep anything edited since. */
    settleDetail(linkId: string, submitted: DetailDraft) {
      update((s) => {
        const now = s.details[linkId];
        if (!now) return {};
        const allow: Partial<Allow> = {};
        for (const key of Object.keys(now.allow) as Array<keyof Allow>) if (!(key in submitted.allow) || submitted.allow[key] !== now.allow[key]) allow[key] = now.allow[key];
        const next: DetailDraft = {
          label: now.label === submitted.label ? null : now.label,
          expiryDay: now.expiryDay === submitted.expiryDay ? null : now.expiryDay,
          passcode: now.passcode === submitted.passcode ? "" : now.passcode,
          removePasscode: now.removePasscode === submitted.removePasscode ? false : now.removePasscode,
          allow,
        };
        const untouched = next.label === null && next.expiryDay === null && next.passcode === "" && !next.removePasscode && Object.keys(next.allow).length === 0;
        return { details: untouched ? without(s.details, linkId) : { ...s.details, [linkId]: next } };
      });
    },
    resetDetail(linkId: string) { update((s) => ({ details: without(s.details, linkId) })); },

    /**
     * The create or replace answered: show the URL once. A created link clears what it was made from, and only that: with `submitted`
     * (the Videos and the draft as sent), a tick or field the person changed while the request was out stays. Without it, everything goes.
     */
    showReveal(reveal: Reveal, submitted?: { videoIds: readonly string[]; draft: CreateDraft }) {
      update((s) => {
        const reveals = queued([...s.reveals, reveal]);
        if (reveal.origin !== "create") return { ...reveals, view: { kind: "reveal" } };
        if (!submitted) return { ...reveals, view: { kind: "reveal" }, selection: new Set<string>(), create: emptyCreate() };
        const sent = submitted.draft; const now = s.create;
        const grants: Record<string, readonly string[]> = {};
        for (const [videoId, ids] of Object.entries(now.grants)) {
          const was = sent.grants[videoId];
          if (!(submitted.videoIds.includes(videoId) && was && sameList(was, ids))) grants[videoId] = ids;
        }
        const create: CreateDraft = {
          label: now.label === sent.label ? "" : now.label,
          passcode: now.passcode === sent.passcode ? "" : now.passcode,
          expiryDay: now.expiryDay === sent.expiryDay ? null : now.expiryDay,
          allow: now.allow.comments === sent.allow.comments && now.allow.approve === sent.allow.approve && now.allow.download === sent.allow.download ? { ...DEFAULT_ALLOW } : now.allow,
          grants,
        };
        return { ...reveals, view: { kind: "reveal" }, selection: new Set([...s.selection].filter((id) => !submitted.videoIds.includes(id))), create };
      });
    },
    dismissReveal() {
      update((s) => {
        const [done, ...rest] = s.reveals;
        if (rest.length > 0) return queued(rest);
        return { ...queued([]), view: done ? { kind: "detail", linkId: done.linkId } : { kind: "list" } };
      });
    },

    clearProblem(scope: string) { if (state.problems[scope]) update((s) => ({ problems: without(s.problems, scope) })); },

    /**
     * Sends one request for `scope`. Refused (false) while its `lock` (default: the scope itself) already has one out. Every write on a
     * link passes the link id as the lock: ONE WRITE IN FLIGHT PER LINK, so responses cannot arrive out of order for a link and a later
     * one is always built on the earlier answer (the UI locks the link's controls while `pending` holds any of its scopes). `ok` runs only if this op still owns the scope
     * (nothing cancelled or retired it meanwhile); a failure leaves a classified problem on the scope. Resolves to whether it succeeded.
     */
    async run<T>(scope: string, task: () => Promise<T>, ok: (result: T) => void, onFail?: (problem: Problem) => void, lock: string = scope): Promise<boolean> {
      if (dead || owner.has(lock)) return false;
      const op = nextOp++;
      owner.set(lock, op);
      update((s) => ({ pending: new Set(s.pending).add(scope), problems: without(s.problems, scope) }));
      const settle = () => { owner.delete(lock); update((s) => { const pending = new Set(s.pending); pending.delete(scope); return { pending }; }); };
      try {
        const result = await task();
        if (owner.get(lock) !== op) return false;
        settle(); ok(result);
        return true;
      } catch (error) {
        if (owner.get(lock) !== op) return false;
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
