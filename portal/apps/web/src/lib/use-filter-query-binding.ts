/**
 * The state machine every Quincy filter bar shares (#255, extracted for the Dashboard's Filter in
 * #428): a ReUI `Filters` chip row bound to a URL-held facet.
 *
 * The bar holds its own `FilterQuery`, because an unfinished chip (a field picked, no condition or
 * value yet) has no URL spelling and must survive the URL echo of an unrelated edit. On every change
 * the local query is set, and when it projects to a facet that differs from the URL's — the URL as
 * it will read once the bar's own pending writes land — `onFacetChange` pushes it. The local query
 * is re-seeded from the URL only when the URL facet CHANGES to something that is neither one of the
 * bar's own pending writes nor the local projection — Back/Forward, a reload, an empty state's
 * Clear — so the bar's own write, echoing back (even late, behind a newer edit), never resets chip
 * ids, focus or an open menu, nor reverts that newer edit.
 *
 * Callers supply the pure mapping (`toQuery` / `toFacet` / `facetKey`) and, optionally, a write
 * adjustment (`forWrite`, the Gantt's Delivered pair) with the one-line reason for it (`noticeFor`)
 * and the query reconciliation that keeps chip ids when the write changed more than the edit
 * (`reconcile`). `toFacet` returning `null` vetoes the edit (an `or`, a group, a negated rule, a
 * second rule on one field).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { countFilterRules, type FilterChangeDetails, type FilterQuery } from "../components/reui/filters/filters";

export type FilterBindingSpec<TFacet, TValue> = {
  /** The facet the URL holds right now. */
  facet: TFacet;
  facetKey: (facet: TFacet) => string;
  toQuery: (facet: TFacet) => FilterQuery<TValue>;
  toFacet: (query: FilterQuery<TValue>) => TFacet | null;
  /** Adjusts the facet an edit produced before it is written (the Delivered pair). */
  forWrite?: (previous: TFacet, edit: TFacet) => TFacet;
  /** Why `forWrite` changed more than the user's edit, or `null`. */
  noticeFor?: (edit: TFacet, written: TFacet) => string | null;
  /** Brings the edited query in line with a facet `forWrite` changed, keeping chip identities. */
  reconcile?: (edited: FilterQuery<TValue>, written: TFacet) => FilterQuery<TValue>;
  /** Pushes a new facet to the URL; it arrives back through `facet`. */
  onFacetChange: (next: TFacet) => void;
  /** The last chip was removed or Clear emptied the bar (focus belongs on the trigger). */
  onEmptied?: () => void;
};

export type FilterBinding<TValue> = {
  query: FilterQuery<TValue>;
  /** Why the bar's last write changed more than the user's edit, or "". */
  notice: string;
  onQueryChange: (edited: FilterQuery<TValue>, details: FilterChangeDetails<TValue>) => void;
  onBeforeQueryChange: (next: FilterQuery<TValue>) => boolean;
};

export function useFilterQueryBinding<TFacet, TValue>(spec: FilterBindingSpec<TFacet, TValue>): FilterBinding<TValue> {
  const { facet, facetKey, toQuery, toFacet } = spec;
  const urlKey = facetKey(facet);
  const [query, setQuery] = useState<FilterQuery<TValue>>(() => toQuery(facet));
  // The keys of the bar's own writes whose URL has not landed yet, oldest first.
  const [pending, setPending] = useState<readonly string[]>([]);
  // Re-seed during render (not an effect, which would paint the stale chips for a frame), only on
  // a URL change the local query does not already say. A URL that is one of the bar's own pending
  // writes is its echo: a stale one (a newer write is still in flight) must not revert the newer
  // edit, so the local query wins and only the landed writes are dropped. Anything else is an
  // outside navigation, which re-seeds and forgets the pending writes. Trimmed only here, on a URL
  // change, never by comparing with a stale `urlKey` on an unrelated render.
  const [seenUrlKey, setSeenUrlKey] = useState(urlKey);
  const [notice, setNotice] = useState("");
  if (seenUrlKey !== urlKey) {
    setSeenUrlKey(urlKey);
    const landed = pending.indexOf(urlKey);
    if (landed >= 0) {
      setPending(pending.slice(landed + 1));
    } else {
      if (pending.length > 0) setPending([]);
      if (notice) setNotice("");
      const local = toFacet(query);
      if (!local || facetKey(local) !== urlKey) setQuery(toQuery(facet));
    }
  }

  const latest = useRef({ urlKey, pending, query, spec });
  useEffect(() => {
    latest.current = { urlKey, pending, query, spec };
  });

  const onQueryChange = useCallback((edited: FilterQuery<TValue>, details: FilterChangeDetails<TValue>) => {
    const current = latest.current;
    const { spec: live } = current;
    let next = edited;
    const edit = live.toFacet(edited);
    const previous = live.toFacet(current.query);
    // A write adjustment (the Delivered pair): the chips follow, keeping their ids, so the write's
    // own echo finds nothing to re-seed.
    const facetToWrite = edit && previous && live.forWrite ? live.forWrite(previous, edit) : edit;
    if (edit && facetToWrite && live.reconcile && live.facetKey(facetToWrite) !== live.facetKey(edit)) next = live.reconcile(edited, facetToWrite);
    // Say so once, visibly and through the status line, when the write changed more than the edit.
    setNotice((edit && facetToWrite && live.noticeFor?.(edit, facetToWrite)) || "");
    current.query = next;
    setQuery(next);
    if (facetToWrite) {
      // Compare with what the URL will say once the bar's own writes land, not the last rendered
      // URL: an edit that undoes a still-pending write must be written too.
      const key = live.facetKey(facetToWrite);
      if (key !== (current.pending.at(-1) ?? current.urlKey)) {
        current.pending = [...current.pending, key];
        setPending(current.pending);
        live.onFacetChange(facetToWrite);
      }
    }
    if ((details.reason === "remove" || details.reason === "clear") && countFilterRules(next) === 0) live.onEmptied?.();
  }, []);

  const onBeforeQueryChange = useCallback((next: FilterQuery<TValue>) => latest.current.spec.toFacet(next) !== null, []);

  return { query, notice, onQueryChange, onBeforeQueryChange };
}
