import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AvatarStack } from "./AvatarStack";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AvatarStack", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });
  const person = (n: number, extra: { inactive?: boolean; name?: string } = {}) => ({ id: `id-${n}`, name: extra.name ?? `Person ${n}`, inactive: extra.inactive });
  const labels = () => [...host.querySelectorAll<HTMLElement>('[role="img"]')].map((el) => el.getAttribute("aria-label"));

  it("renders the empty label for no people", () => {
    act(() => root.render(<AvatarStack people={[]} personNoun="Editor" emptyLabel="No Editor assigned" />));
    expect(labels()).toEqual(["No Editor assigned"]);
  });

  it("shows three avatars and a +N overflow with a pluralised label", () => {
    act(() => root.render(<AvatarStack people={[1, 2, 3, 4, 5].map((n) => person(n))} personNoun="team member" emptyLabel="None" />));
    expect(labels()).toEqual(["Person 1", "Person 2", "Person 3", "2 more team members"]);
    act(() => root.render(<AvatarStack people={[1, 2, 3, 4].map((n) => person(n))} personNoun="Editor" emptyLabel="None" />));
    expect(labels().at(-1)).toBe("1 more Editor");
    expect(host.textContent).toContain("+1");
  });

  it("suffixes an inactive person and names an unnamed one", () => {
    act(() => root.render(<AvatarStack people={[person(1, { inactive: true }), person(2, { name: "  " })]} personNoun="Editor" emptyLabel="None" />));
    expect(labels()).toEqual(["Person 1 (inactive)", "Editor (name unavailable)"]);
  });

  it("decorative hides the whole stack from assistive tech", () => {
    act(() => root.render(<AvatarStack decorative people={[person(1)]} personNoun="Editor" emptyLabel="None" />));
    expect(host.firstElementChild!.getAttribute("aria-hidden")).toBe("true");
  });
});
