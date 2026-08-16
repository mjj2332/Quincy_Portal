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
  return <div className="mention-autocomplete">
    {state === "loading" && <div className="mention-autocomplete__status" role="status">Finding staff…</div>}
    {state === "error" && <div className="mention-autocomplete__status" role="alert">Staff suggestions are unavailable.</div>}
    {state === "idle" && <ul id={listboxId} className="mention-autocomplete__list" role="listbox" aria-label="Mention suggestions">
      {users.map((user, index) => <li id={`${listboxId}-${user.id}`} key={user.id} role="option" aria-selected={index === activeIndex}>
        <button type="button" className={`mention-autocomplete__option${index === activeIndex ? " is-active" : ""}`} onMouseDown={(event) => event.preventDefault()} onClick={() => onSelect(user)}>
          <span>{user.name}</span><small>{user.role}</small>
        </button>
      </li>)}
      {!users.length && <li className="mention-autocomplete__status" role="status">No active staff found.</li>}
    </ul>}
  </div>;
});
