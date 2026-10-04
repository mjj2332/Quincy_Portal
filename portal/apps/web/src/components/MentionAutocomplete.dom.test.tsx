import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MentionAutocomplete, type MentionAutocompleteHandle, type MentionableUser } from "./MentionAutocomplete";

/** #514: the mention list's active row reads like Select / Combobox's highlighted row (one cue, no left bar). */
const USERS: MentionableUser[] = [
  { id: "u1", name: "Ari Photographer", role: "photographer" },
  { id: "u2", name: "Eli Editor", role: "editor" },
  { id: "u3", name: "Nora Mention", role: "editor" },
];
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount() {
  const onSelect = vi.fn<(user: MentionableUser) => void>();
  const a11y = vi.fn<(state: { listboxId: string; activeId?: string; expanded: boolean }) => void>();
  const handle = createRef<MentionAutocompleteHandle>();
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<MentionAutocomplete ref={handle} query="" loadMentionables={async () => USERS} onSelect={onSelect} onDismiss={() => undefined} onAccessibilityChange={a11y} />);
    await Promise.resolve(); await Promise.resolve();
  });
  return { host, onSelect, a11y, handle };
}
const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-slot="mention-option"]')];
const activeRow = (host: HTMLElement) => rows(host).filter((row) => row.dataset.active === "true");
const key = (handle: { current: MentionAutocompleteHandle | null }, name: string) =>
  act(async () => { handle.current!.handleKeyDown(new KeyboardEvent("keydown", { key: name, cancelable: true })); await Promise.resolve(); });
const lastActiveId = (a11y: ReturnType<typeof vi.fn>) => (a11y.mock.calls.at(-1)![0] as { activeId?: string }).activeId;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null; document.body.replaceChildren();
});

describe("MentionAutocomplete active row (#514)", () => {
  it("renders the popup and rows under the mention slots", async () => {
    const { host } = await mount();
    expect(host.querySelector('[data-slot="mention-content"]')).not.toBeNull();
    expect(rows(host)).toHaveLength(3);
  });

  it("moves the one active row (and aria-activedescendant) with the arrow keys", async () => {
    const { host, a11y, handle } = await mount();
    expect(activeRow(host).map((row) => row.textContent)).toEqual([rows(host)[0]!.textContent]);
    const idOf = (index: number) => rows(host)[index]!.closest("li")!.id;
    expect(lastActiveId(a11y)).toBe(idOf(0));
    await key(handle, "ArrowDown");
    expect(activeRow(host)).toEqual([rows(host)[1]]);
    expect(lastActiveId(a11y)).toBe(idOf(1));
    await key(handle, "ArrowUp"); await key(handle, "ArrowUp");
    expect(activeRow(host)).toEqual([rows(host)[2]]);
    expect(lastActiveId(a11y)).toBe(idOf(2));
  });

  it("hover moves the active row", async () => {
    const { host, a11y } = await mount();
    await act(async () => { rows(host)[2]!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })); await Promise.resolve(); });
    expect(activeRow(host)).toEqual([rows(host)[2]]);
    expect(lastActiveId(a11y)).toBe(rows(host)[2]!.closest("li")!.id);
  });

  it("Enter selects the active person and a click selects the clicked one", async () => {
    const { host, onSelect, handle } = await mount();
    await key(handle, "ArrowDown");
    await key(handle, "Enter");
    expect(onSelect).toHaveBeenLastCalledWith(USERS[1]);
    await act(async () => { rows(host)[2]!.click(); await Promise.resolve(); });
    expect(onSelect).toHaveBeenLastCalledWith(USERS[2]);
  });

  it("paints the active row with the shared accent fill, text and radius, and no left bar", async () => {
    const { host } = await mount();
    const row = rows(host)[0]!;
    const tokens = row.className.split(/\s+/);
    expect(tokens).toContain("data-[active=true]:bg-accent");
    expect(tokens).toContain("data-[active=true]:text-accent-foreground");
    expect(tokens).toContain("rounded-md");
    expect(tokens.filter((token) => /border-l|border-left|border-strong/.test(token))).toEqual([]);
    // The role label follows the row's text colour when active.
    expect(row.querySelector("small")!.className).toContain("group-data-[active=true]:text-accent-foreground");
  });
});
