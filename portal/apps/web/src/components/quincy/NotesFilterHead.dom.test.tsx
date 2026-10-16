import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotesFilterHead } from "./NotesFilterHead";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

/**
 * The phone notes head (#879 PR 3b, P1 / P2): the chips name the filters, the menus set them, and search opens in place of the chips and closes back to the Search icon.
 * It is controlled: the harness below holds the state a screen would.
 */
let root: Root | null = null; let host: HTMLElement;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren(); });

type Status = "open" | "resolved" | "all";
type Visibility = "all" | "public" | "internal";
const reported: string[] = [];

function Harness({ staff = true, initial = { status: "open" as Status, visibility: "all" as Visibility, author: null as string | null, query: null as string | null } }) {
  const [state, setState] = useState(initial);
  return <>
    <NotesFilterHead<Status, Visibility>
      status={{ label: "Show notes that are", value: state.status, onChange: (status) => { setState({ ...state, status }); }, options: [{ value: "open", label: "Open", count: 3 }, { value: "resolved", label: "Resolved", count: 1 }, { value: "all", label: "All", count: 4 }] }}
      {...(staff ? { visibility: { label: "Show notes visible to", value: state.visibility, onChange: (visibility: Visibility) => { setState({ ...state, visibility }); }, options: [{ value: "all" as const, label: "All", count: 3 }, { value: "public" as const, label: "Client-visible", count: 2 }, { value: "internal" as const, label: "Internal", count: 1 }] } } : {})}
      authors={{ value: state.author, options: [{ key: "staff:1", name: "Ada" }, { key: "guest:2", name: "Ben" }], onChange: (author) => { setState({ ...state, author }); } }}
      query={state.query}
      onQueryChange={(query) => { setState({ ...state, query }); }}
      onSearchChange={(next) => { reported.push(next); }}
    />
    <span data-testid="state">{JSON.stringify(state)}</span>
  </>;
}

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const state = () => JSON.parse(q("state")!.textContent!) as { status: Status; visibility: Visibility; author: string | null; query: string | null };
const click = (element: HTMLElement) => act(async () => { element.click(); await Promise.resolve(); });
const render = (node: React.ReactNode) => act(async () => { root!.render(node); await Promise.resolve(); });
const radio = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) => item.textContent?.startsWith(name))!;

describe("NotesFilterHead (#879 PR 3b)", () => {
  beforeEach(() => { reported.length = 0; });

  it("names the status and its count, then the visibility once one is set", async () => {
    await render(<Harness />);
    expect(q("notes-filter-status")!.textContent).toBe("Open · 3");
    expect(q("notes-filter-author")!.textContent).toBe("Everyone");
    await render(<Harness key="internal" initial={{ status: "open", visibility: "internal", author: null, query: null }} />);
    expect(q("notes-filter-status")!.textContent).toBe("Open · Internal · 3");
  });

  it("the status menu offers status, then visibility (staff), each with its count", async () => {
    await render(<Harness />);
    await click(q("notes-filter-status")!);
    const items = [...document.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent);
    expect(items).toEqual(["Open3", "Resolved1", "All4", "All3", "Client-visible2", "Internal1"]);
    await click(radio("Resolved"));
    expect(state().status).toBe("resolved");
  });

  it("a guest's status menu has no visibility group", async () => {
    await render(<Harness staff={false} />);
    await click(q("notes-filter-status")!);
    expect([...document.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent)).toEqual(["Open3", "Resolved1", "All4"]);
  });

  it("the author menu offers Everyone and each author; choosing one names it on the chip", async () => {
    await render(<Harness />);
    await click(q("notes-filter-author")!);
    expect([...document.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent)).toEqual(["Everyone", "Ada", "Ben"]);
    await click(radio("Ben"));
    expect(state().author).toBe("guest:2");
    expect(q("notes-filter-author")!.textContent).toBe("Ben");
  });

  it("Everyone clears a chosen author", async () => {
    await render(<Harness initial={{ status: "open", visibility: "all", author: "staff:1", query: null }} />);
    expect(q("notes-filter-author")!.textContent).toBe("Ada");
    await click(q("notes-filter-author")!);
    await click(radio("Everyone"));
    expect(state().author).toBeNull();
  });

  it("Search opens a field in place of the chips, focused; X clears and closes it and focus returns to Search", async () => {
    await render(<Harness />);
    await click(q("notes-filter-search")!);
    expect(state().query).toBe("");
    expect(q("notes-filter-status")).toBeNull();
    const field = q("notes-search-field") as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    expect(field.closest("[data-notes-search]")).not.toBeNull();
    expect(reported.at(-1)).toBe("typing");
    await click(q("notes-search-close")!);
    expect(state().query).toBeNull();
    expect(document.activeElement).toBe(q("notes-filter-search"));
    expect(reported.at(-1)).toBe("closed");
  });

  it("Escape in the field closes search and is not passed on", async () => {
    await render(<Harness />);
    await click(q("notes-filter-search")!);
    const outer = vi.fn();
    document.body.addEventListener("keydown", outer);
    const field = q("notes-search-field")!;
    await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(state().query).toBeNull();
    expect(document.activeElement).toBe(q("notes-filter-search"));
    expect(outer).not.toHaveBeenCalled();
  });

  it("a reset from elsewhere closes search and reports it, without moving focus", async () => {
    await render(<Harness initial={{ status: "open", visibility: "all", author: null, query: "logo" }} />);
    expect((q("notes-search-field") as HTMLInputElement).value).toBe("logo");
    expect(reported).toEqual(["open"]);
    await act(async () => { root!.unmount(); });
    root = null;
    expect(reported).toEqual(["open", "closed"]);
  });

  it("the Search icon focuses the field inside its own click, so iOS raises the keyboard on the first tap", async () => {
    await render(<Harness />);
    let during: Element | null = null;
    await act(async () => { q("notes-filter-search")!.click(); during = document.activeElement; });
    expect(during).not.toBeNull();
    expect(during).toBe(q("notes-search-field"));
  });

  it("reports typing while the field has the focus, open once it lets go, and closed when search closes", async () => {
    await render(<Harness />);
    await click(q("notes-filter-search")!);
    expect(reported.at(-1)).toBe("typing");
    const field = q("notes-search-field") as HTMLInputElement;
    await act(async () => { field.blur(); });
    expect(reported.at(-1)).toBe("open");
    expect(state().query).toBe("");
    await act(async () => { field.focus(); });
    expect(reported.at(-1)).toBe("typing");
    await click(q("notes-search-close")!);
    expect(reported.at(-1)).toBe("closed");
    expect(reported).not.toContain(undefined);
  });

  it("pressing X does not take the focus from the field first (the keyboard and the layout hold until it closes search)", async () => {
    await render(<Harness />);
    await click(q("notes-filter-search")!);
    const x = q("notes-search-close")!;
    for (const type of ["pointerdown", "mousedown"]) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true });
      await act(async () => { x.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it("names the staff menu's two groups Status and Visibility, in label type; a guest's one group has no label", async () => {
    await render(<Harness />);
    await click(q("notes-filter-status")!);
    const status = q("notes-filter-status-label")!;
    const visibility = q("notes-filter-visibility-label")!;
    expect([status.textContent, visibility.textContent]).toEqual(["Status", "Visibility"]);
    for (const label of [status, visibility]) {
      expect(label.className).toContain("[font:var(--type-label)]");
      expect(label.className).toContain("text-foreground-secondary");
    }
    expect(status.compareDocumentPosition(radio("Open")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => { root!.unmount(); });
    root = createRoot(host);
    await render(<Harness staff={false} />);
    await click(q("notes-filter-status")!);
    expect(q("notes-filter-status-label")).toBeNull();
  });
});
