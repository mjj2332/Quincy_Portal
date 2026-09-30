import { describe, expect, it, vi } from "vitest";
import { createDashboardBackdropSource } from "./dashboard-location";

const projectId = "123e4567-e89b-42d3-a456-426614174000";
const project = `/projects/${projectId}`;

/** A controllable stand-in for the history adapter: the test moves `location` and calls `fire()`. */
function fakeAdapter(initial: string) {
  let location = initial;
  const listeners = new Set<() => void>();
  const push = vi.fn((next: string) => { location = next; listeners.forEach((l) => l()); });
  const replace = vi.fn((next: string) => { location = next; listeners.forEach((l) => l()); });
  return {
    adapter: {
      getLocation: () => location,
      subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
      push, replace,
    },
    push, replace,
    listenerCount: () => listeners.size,
    /** The browser moved (Back/Forward): the location changed with no adapter write. */
    arrive(next: string) { location = next; listeners.forEach((l) => l()); },
  };
}
const sheetState = (backdrop: string, depth = 1) => ({ quincySheet: { v: 1, backdrop, depth, prev: backdrop } });

describe("Dashboard location lens (#366)", () => {
  it("passes a real Dashboard location straight through and reports not-backdrop", () => {
    const { adapter } = fakeAdapter("/?view=list&q=smith");
    const lens = createDashboardBackdropSource(adapter, () => null);
    expect(lens.getLocation()).toBe("/?view=list&q=smith");
    expect(lens.isBackdrop()).toBe(false);
  });

  it("remembers the last Dashboard location and returns it while a sheet is the real location", () => {
    const fake = fakeAdapter("/?view=kanban&q=smith");
    const lens = createDashboardBackdropSource(fake.adapter, () => sheetState("/?view=kanban&q=smith"));
    const seen: string[] = [];
    const off = lens.subscribe(() => seen.push(lens.getLocation()));
    fake.adapter.push(project);
    expect(lens.isBackdrop()).toBe(true);
    expect(lens.getLocation()).toBe("/?view=kanban&q=smith");
    expect(lens.backdrop()).toBe("/?view=kanban&q=smith");
    expect(seen).toEqual(["/?view=kanban&q=smith"]);
    off();
  });

  it("starts from the state's backdrop on a cold sheet load, or '/' with none", () => {
    expect(createDashboardBackdropSource(fakeAdapter(project).adapter, () => sheetState("/?view=calendar")).getLocation()).toBe("/?view=calendar");
    expect(createDashboardBackdropSource(fakeAdapter(project).adapter, () => null).getLocation()).toBe("/");
    expect(createDashboardBackdropSource(fakeAdapter(project).adapter, () => sheetState("/admin")).getLocation()).toBe("/");
  });

  it("keeps a Dashboard-shaped write in memory while backdrop: no adapter write, rewritten flagged", () => {
    const fake = fakeAdapter(project);
    const lens = createDashboardBackdropSource(fake.adapter, () => sheetState("/"));
    const seen: string[] = [];
    const off = lens.subscribe(() => seen.push(lens.getLocation()));
    lens.replace("/?view=calendar&date=2026-08-30&sub=agenda&layers=project%2Cchecklist");
    lens.push("/?view=list");
    expect(fake.replace).not.toHaveBeenCalled();
    expect(fake.push).not.toHaveBeenCalled();
    expect(lens.getLocation()).toBe("/?view=list");
    expect(lens.backdropRewritten()).toBe(true);
    expect(seen).toEqual(["/?view=calendar&date=2026-08-30&sub=agenda&layers=project%2Cchecklist", "/?view=list"]);
    lens.resetRewritten();
    expect(lens.backdropRewritten()).toBe(false);
    off();
  });

  it("forwards a non-Dashboard push (the Dashboard's own project opens) to the adapter for real", () => {
    const fake = fakeAdapter("/?view=list");
    const lens = createDashboardBackdropSource(fake.adapter, () => null);
    lens.push(project);
    expect(fake.push).toHaveBeenCalledWith(project);
    // and a Dashboard write while NOT a backdrop is also forwarded
    const fake2 = fakeAdapter("/?view=list");
    const lens2 = createDashboardBackdropSource(fake2.adapter, () => null);
    lens2.replace("/?view=kanban");
    expect(fake2.replace).toHaveBeenCalledWith("/?view=kanban");
    expect(lens2.backdropRewritten()).toBe(false);
  });

  it("re-seeds from the state of a sheet entry it lands on (Back from /admin into a sheet)", () => {
    const fake = fakeAdapter("/?view=list");
    let state: unknown = null;
    const lens = createDashboardBackdropSource(fake.adapter, () => state);
    const off = lens.subscribe(() => undefined);
    state = sheetState("/?view=kanban");
    fake.arrive(project);
    expect(lens.getLocation()).toBe("/?view=kanban");
    fake.arrive("/admin");
    expect(lens.getLocation()).toBe("/admin");
    state = sheetState("/?view=list&q=x");
    fake.arrive(project);
    expect(lens.getLocation()).toBe("/?view=list&q=x");
    off();
  });

  it("does not let a tab replace on the same entry clobber an in-memory rewrite", () => {
    const fake = fakeAdapter("/?view=list");
    const state = sheetState("/?view=list");
    const lens = createDashboardBackdropSource(fake.adapter, () => state);
    const off = lens.subscribe(() => undefined);
    fake.adapter.push(project);
    lens.replace("/?view=kanban");
    fake.adapter.replace(`${project}?tab=raw`);
    expect(lens.getLocation()).toBe("/?view=kanban");
    off();
  });

  it("subscribes to the adapter lazily and only while it has subscribers", () => {
    const fake = fakeAdapter("/");
    const lens = createDashboardBackdropSource(fake.adapter, () => null);
    expect(fake.listenerCount()).toBe(0);
    const off1 = lens.subscribe(() => undefined);
    const off2 = lens.subscribe(() => undefined);
    expect(fake.listenerCount()).toBe(1);
    off1(); off2();
    expect(fake.listenerCount()).toBe(0);
  });
});
