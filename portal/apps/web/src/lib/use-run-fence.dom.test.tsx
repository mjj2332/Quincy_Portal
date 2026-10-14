// Happy-dom proves mount/key/begin bookkeeping only; it cannot prove real
// network timing or browser scheduling.
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useRunFence, type RunFence } from "./use-run-fence";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let fence: RunFence | null = null;
function Probe({ fenceKey }: { fenceKey?: string }) {
  fence = useRunFence(fenceKey);
  return null;
}

describe("useRunFence", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    fence = null;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("keeps a ticket current while nothing has changed", () => {
    act(() => root.render(<Probe fenceKey="a" />));
    const t = fence!.begin();
    act(() => root.render(<Probe fenceKey="a" />));
    expect(t.isCurrent()).toBe(true);
  });

  it("makes a ticket stale on unmount", () => {
    act(() => root.render(<Probe />));
    const t = fence!.begin();
    act(() => root.unmount());
    expect(t.isCurrent()).toBe(false);
    root = createRoot(host);
  });

  it("makes an older ticket stale when a newer begin() happens", () => {
    act(() => root.render(<Probe />));
    const first = fence!.begin();
    const second = fence!.begin();
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
  });

  it("makes a ticket stale on a key change and never revives it on A to B to A", () => {
    act(() => root.render(<Probe fenceKey="a" />));
    const t = fence!.begin();
    act(() => root.render(<Probe fenceKey="b" />));
    expect(t.isCurrent()).toBe(false);
    act(() => root.render(<Probe fenceKey="a" />));
    expect(t.isCurrent()).toBe(false);
    expect(fence!.begin().isCurrent()).toBe(true);
  });

  it("makes every ticket stale on invalidate()", () => {
    act(() => root.render(<Probe />));
    const t = fence!.begin();
    fence!.invalidate();
    expect(t.isCurrent()).toBe(false);
  });

  it("returns a stable fence across renders", () => {
    act(() => root.render(<Probe fenceKey="a" />));
    const first = fence;
    act(() => root.render(<Probe fenceKey="a" />));
    expect(fence).toBe(first);
  });

  it("gives a current ticket after mount under StrictMode", () => {
    act(() =>
      root.render(
        <StrictMode>
          <Probe />
        </StrictMode>,
      ),
    );
    expect(fence!.begin().isCurrent()).toBe(true);
  });
});
