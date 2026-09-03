import { forwardRef, useEffect, useId, useImperativeHandle, useState } from "react";
import type { Role } from "@quincy/shared";

export type MentionableUser = { id: string; name: string; role: Role };
export type MentionAutocompleteHandle = { handleKeyDown(event: KeyboardEvent): boolean };

export const MentionAutocomplete = forwardRef<MentionAutocompleteHandle, {
  query: string | null;
  loadMentionables: (query: string) => Promise<MentionableUser[]>;
  onSelect: (user: MentionableUser) => void;
  onAccessibilityChange: (state: { listboxId: string; activeId?: string; expanded: boolean }) => void;
}>(function MentionAutocomplete({ query, loadMentionables, onSelect, onAccessibilityChange }, ref) {
  const listboxId = useId();
  const [users, setUsers] = useState<MentionableUser[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  useEffect(() => {
    let current = true;
    if (query === null) { setUsers([]); setState("idle"); return; }
    setState("loading"); setActiveIndex(0);
    void loadMentionables(query).then((next) => {
      if (!current) return;
      setUsers(next); setState("idle");
    }, () => { if (current) { setUsers([]); setState("error"); } });
    return () => { current = false; };
  }, [query, loadMentionables]);

  useImperativeHandle(ref, () => ({
    handleKeyDown(event) {
      if (query === null || state === "loading") return false;
      if (event.key === "ArrowDown" && users.length) { event.preventDefault(); setActiveIndex((index) => (index + 1) % users.length); return true; }
      if (event.key === "ArrowUp" && users.length) { event.preventDefault(); setActiveIndex((index) => (index - 1 + users.length) % users.length); return true; }
      if ((event.key === "Enter" || event.key === "Tab") && users[activeIndex]) { event.preventDefault(); onSelect(users[activeIndex]!); return true; }
      if (event.key === "Escape") { event.preventDefault(); setUsers([]); return true; }
      return false;
    },
  }), [activeIndex, onSelect, query, state, users]);

  const activeId = query !== null && users[activeIndex] ? `${listboxId}-${users[activeIndex]!.id}` : undefined;
  useEffect(() => {
    onAccessibilityChange({ listboxId, activeId, expanded: query !== null });
  }, [activeId, listboxId, onAccessibilityChange, query]);

  if (query === null) return null;
  return <div className="[border-style:solid] border-[length:var(--border-width-hair)] border-border bg-card shadow-[var(--shadow-md)]">
    {state === "loading" && <div className="p-[var(--space-2)] [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary" role="status">Finding staff…</div>}
    {state === "error" && <div className="p-[var(--space-2)] [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary" role="alert">Staff suggestions are unavailable.</div>}
    {state === "idle" && <ul id={listboxId} className="m-0 p-[var(--space-1)] list-none" role="listbox" aria-label="Mention suggestions">
      {users.map((user, index) => <li id={`${listboxId}-${user.id}`} key={user.id} role="option" aria-selected={index === activeIndex}>
        <button
          type="button"
          data-active={index === activeIndex ? "true" : undefined}
          className="flex items-baseline justify-between gap-[var(--space-3)] w-full text-left min-w-0 min-h-[44px] px-[var(--space-3)] py-[var(--space-2)] bg-transparent border-0 [border-left-style:solid] border-l-[length:var(--border-width-bold)] border-l-transparent text-foreground [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] cursor-pointer hover:bg-secondary active:bg-surface-sunken data-[active=true]:border-l-border-strong focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)] focus-visible:!outline-[var(--focus-ring)] focus-visible:!outline-offset-[-2px]"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(user)}
        >
          <span>{user.name}</span><small className="text-foreground-secondary capitalize">{user.role}</small>
        </button>
      </li>)}
      {!users.length && <li className="p-[var(--space-2)] [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary" role="status">No active staff found.</li>}
    </ul>}
  </div>;
});
