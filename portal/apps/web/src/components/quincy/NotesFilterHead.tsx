import { useEffect, useRef, type Ref } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { Button } from "../reui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "../reui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "../reui/input-group";

/** One choice of a filter, with the number of notes choosing it would show. */
export type FilterChoice<Value extends string> = { value: Value; label: string; count: number };
/** One filter axis: its value, its choices in menu order, and the change. */
export type FilterAxis<Value extends string> = { value: Value; options: ReadonlyArray<FilterChoice<Value>>; onChange: (next: Value) => void; /** The menu group's accessible name. */ label: string };

/** Everyone's value in the author menu (a radio group's value is a string; Everyone is `null` to the caller). */
const EVERYONE = "";
const ITEM = "max-[721px]:min-h-11";
const CHIP_MENU = "w-auto min-w-48 max-w-[min(20rem,calc(100vw-var(--space-6)))]";

/**
 * The phone notes head (#879 PR 3b, P1 / P2 `NotesFilter`): "Open · N ⌄" and "Everyone ⌄" chips and a Search icon, in one row inside the notes scroll. Search replaces the chips with a
 * field in place; its X and Escape clear it, close it and give focus back to the Search icon. It holds no state: the screen owns the filters (staff `useVideoNotes`, guest
 * `guest-notes-filter`), so the same head serves both, and it knows nothing of either (it imports only `reui/*` and lucide).
 *
 * - `status` is the chip's axis; `visibility` (staff only) shares its menu under a separator, and once it is set to anything but its first choice the chip names it
 *   ("Open · Internal · 3"). The chip's number is the chosen status's count, which the caller counts under every other filter.
 * - A choice closes its menu (a phone menu is one tap), so the chip shows the result at once.
 * - `authors.value` is a key from `authors.options`, or null for Everyone.
 * - `query` is null while search is closed and a string (possibly empty) while it is open. `onSearchOpenChange` reports the field opening and closing, however it happens
 *   (the X, Escape, or the caller resetting the filters), so a phone sheet can take its full stop while the keyboard is up.
 *
 * The field carries `data-notes-search`: a screen whose Escape closes the viewer leaves that Escape to the field.
 */
export function NotesFilterHead<Status extends string, Visibility extends string>({ status, visibility, authors, query, onQueryChange, onSearchOpenChange, headRef, className }: {
  status: FilterAxis<Status>;
  visibility?: FilterAxis<Visibility>;
  authors: { value: string | null; options: ReadonlyArray<{ key: string; name: string }>; onChange: (next: string | null) => void };
  query: string | null;
  onQueryChange: (next: string | null) => void;
  onSearchOpenChange?: (open: boolean) => void;
  /** The row itself: what a screen measures (the hairline under the head follows it). */
  headRef?: Ref<HTMLDivElement>;
  className?: string;
}) {
  const open = query !== null;
  const fieldRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLButtonElement>(null);
  // Focus follows the person's own opening and closing only; a reset from elsewhere (a post, another Version) leaves focus where it is.
  const focusNext = useRef<"field" | "search" | null>(null);
  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === "field") fieldRef.current?.focus({ preventScroll: true });
    else if (target === "search") searchRef.current?.focus({ preventScroll: true });
  }, [open]);
  const reportRef = useRef(onSearchOpenChange);
  reportRef.current = onSearchOpenChange;
  // Open → reported once; closed or unmounted (the panel goes with its Version) → reported once.
  useEffect(() => {
    if (!open) return undefined;
    reportRef.current?.(true);
    return () => { reportRef.current?.(false); };
  }, [open]);
  const close = () => { focusNext.current = "search"; onQueryChange(null); };

  const chosenStatus = status.options.find((option) => option.value === status.value) ?? status.options[0];
  const chosenVisibility = visibility && visibility.value !== visibility.options[0]?.value ? visibility.options.find((option) => option.value === visibility.value) : undefined;
  const statusChip = [chosenStatus?.label, chosenVisibility?.label, String(chosenStatus?.count ?? 0)].filter(Boolean).join(" · ");
  const author = authors.options.find((option) => option.key === authors.value);

  return <div ref={headRef} data-testid="notes-filter-head" className={`flex min-h-0 items-center gap-[var(--space-2)] border-b border-[color-mix(in_srgb,var(--border)_55%,transparent)] py-[var(--space-2)]${className ? ` ${className}` : ""}`}>
    {open
      ? <InputGroup data-notes-search="" className="h-7 min-h-7 max-[721px]:min-h-7 rounded-[var(--radius-pill)]">
        <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
        <InputGroupInput
          ref={fieldRef}
          type="search"
          data-testid="notes-search-field"
          aria-label="Search notes"
          placeholder="Search notes"
          enterKeyHint="search"
          value={query}
          className="py-0 max-[721px]:py-0 max-[721px]:text-base"
          onChange={(event) => { onQueryChange(event.target.value); }}
          onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" data-testid="notes-search-close" aria-label="Close search" className="relative after:absolute after:-inset-[var(--space-2)]" onClick={close}><X aria-hidden="true" /></InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      : <>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button type="button" variant="outline" size="chip" data-testid="notes-filter-status" />}>{statusChip}<ChevronDown aria-hidden="true" /></DropdownMenuTrigger>
          <DropdownMenuContent align="start" className={CHIP_MENU} data-testid="notes-filter-status-menu">
            <DropdownMenuRadioGroup aria-label={status.label} value={status.value} onValueChange={(next) => { const picked = status.options.find((option) => option.value === next); if (picked) status.onChange(picked.value); }}>
              {status.options.map((option) => <DropdownMenuRadioItem key={option.value} value={option.value} closeOnClick className={ITEM}>{option.label}<DropdownMenuShortcut className="tabular-nums tracking-normal">{option.count}</DropdownMenuShortcut></DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
            {visibility && <>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup aria-label={visibility.label} value={visibility.value} onValueChange={(next) => { const picked = visibility.options.find((option) => option.value === next); if (picked) visibility.onChange(picked.value); }}>
                {visibility.options.map((option) => <DropdownMenuRadioItem key={option.value} value={option.value} closeOnClick className={ITEM}>{option.label}<DropdownMenuShortcut className="tabular-nums tracking-normal">{option.count}</DropdownMenuShortcut></DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </>}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button type="button" variant="outline" size="chip" data-testid="notes-filter-author" className="min-w-0 max-w-full" />}><span className="truncate">{author?.name ?? "Everyone"}</span><ChevronDown aria-hidden="true" /></DropdownMenuTrigger>
          <DropdownMenuContent align="start" className={`${CHIP_MENU} max-h-[min(50dvh,var(--available-height))]`} data-testid="notes-filter-author-menu">
            <DropdownMenuRadioGroup aria-label="Notes by" value={author ? author.key : EVERYONE} onValueChange={(next) => { authors.onChange(next === EVERYONE ? null : String(next)); }}>
              <DropdownMenuRadioItem value={EVERYONE} closeOnClick className={ITEM}>Everyone</DropdownMenuRadioItem>
              {authors.options.map((option) => <DropdownMenuRadioItem key={option.key} value={option.key} closeOnClick className={ITEM}><span className="truncate">{option.name}</span></DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button ref={searchRef} type="button" variant="ghost" size="icon-sm" data-testid="notes-filter-search" aria-label="Search notes" className="relative ms-auto after:absolute after:-inset-[var(--space-2)]" onClick={() => { focusNext.current = "field"; onQueryChange(""); }}><Search aria-hidden="true" /></Button>
      </>}
  </div>;
}
