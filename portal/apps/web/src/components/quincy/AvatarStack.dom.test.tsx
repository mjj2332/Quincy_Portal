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

  it("shows one and exactly three people with no overflow chip", () => {
    act(() => root.render(<AvatarStack people={[person(1)]} personNoun="Assignee" emptyLabel="Unassigned" />));
    expect(labels()).toEqual(["Person 1"]);
    act(() => root.render(<AvatarStack people={[1, 2, 3].map((n) => person(n))} personNoun="Assignee" emptyLabel="Unassigned" />));
    expect(labels()).toEqual(["Person 1", "Person 2", "Person 3"]);
    expect(host.textContent).not.toContain("+");
  });

  it("caps seven people at three and counts four more", () => {
    act(() => root.render(<AvatarStack people={[1, 2, 3, 4, 5, 6, 7].map((n) => person(n))} personNoun="Assignee" emptyLabel="Unassigned" />));
    expect(labels()).toEqual(["Person 1", "Person 2", "Person 3", "4 more Assignees"]);
    expect(host.textContent).toContain("+4");
  });

  describe("hiddenCount (people the viewer may not see)", () => {
    it("with nobody named renders only the count chip, never the empty circle", () => {
      act(() => root.render(<AvatarStack people={[]} hiddenCount={2} personNoun="Assignee" emptyLabel="Unassigned" />));
      expect(labels()).toEqual(["2 others not shown"]);
      expect(host.textContent).toBe("+2 others");
    });

    it("uses the singular for one hidden person", () => {
      act(() => root.render(<AvatarStack people={[]} hiddenCount={1} personNoun="Assignee" emptyLabel="Unassigned" />));
      expect(labels()).toEqual(["1 other not shown"]);
      expect(host.textContent).toBe("+1 others");
    });

    it("folds named overflow and hidden people into one chip with both facts in its label", () => {
      act(() => root.render(<AvatarStack people={[1, 2, 3, 4, 5].map((n) => person(n))} hiddenCount={2} personNoun="Assignee" emptyLabel="Unassigned" />));
      expect(labels()).toEqual(["Person 1", "Person 2", "Person 3", "2 more Assignees and 2 others not shown"]);
      expect(host.textContent).toContain("+4 others");
    });

    it("adds hidden people after the named ones without inventing overflow", () => {
      act(() => root.render(<AvatarStack people={[person(1)]} hiddenCount={2} personNoun="Assignee" emptyLabel="Unassigned" />));
      expect(labels()).toEqual(["Person 1", "2 others not shown"]);
      expect(host.textContent).toContain("+2 others");
    });

    it("never renders a hidden person's identity: only a count is accepted", () => {
      act(() => root.render(<AvatarStack people={[person(1)]} hiddenCount={3} personNoun="Assignee" emptyLabel="Unassigned" />));
      expect(host.textContent).not.toMatch(/Person [2-9]/);
    });
  });
});
