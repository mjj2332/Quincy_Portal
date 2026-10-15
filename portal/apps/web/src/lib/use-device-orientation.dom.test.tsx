import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockViewport, type MockViewport } from "../testing/viewport";
import { useDeviceOrientation } from "./use-device-orientation";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let viewport: MockViewport | null = null;

function Probe({ onTurn }: { onTurn: (landscape: boolean) => void }) { useDeviceOrientation(onTurn); return null; }
async function mount(onTurn: (landscape: boolean) => void) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Probe onTurn={onTurn} />); });
}
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; viewport?.restore(); viewport = null; document.body.replaceChildren();
});

describe("useDeviceOrientation (#880, D14)", () => {
  it("reports no initial value and each turn of the device", async () => {
    viewport = mockViewport({ width: 390, height: 844, coarse: true });
    const onTurn = vi.fn();
    await mount(onTurn);
    expect(onTurn).not.toHaveBeenCalled();
    await viewport.set({ width: 844, height: 390 });
    expect(onTurn).toHaveBeenLastCalledWith(true);
    await viewport.set({ width: 390, height: 844 });
    expect(onTurn).toHaveBeenLastCalledWith(false);
    expect(onTurn).toHaveBeenCalledTimes(2);
  });

  it("a keyboard that makes the portrait viewport landscape-shaped is not a turn", async () => {
    viewport = mockViewport({ width: 390, height: 844, coarse: true });
    const onTurn = vi.fn();
    await mount(onTurn);
    await viewport.set({ height: 300 });
    expect(onTurn).not.toHaveBeenCalled();
  });

  it("falls back to the media query where the device has no screen.orientation", async () => {
    viewport = mockViewport({ width: 390, height: 844, coarse: true, screen: false });
    const onTurn = vi.fn();
    await mount(onTurn);
    await viewport.set({ width: 844, height: 390 });
    expect(onTurn).toHaveBeenCalledWith(true);
  });
});
