import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageTone } from "../../lib/dashboard-appearance";
import { StageKeyRow, type StageKeyEntry } from "./StageKeyRow";

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(node); await Promise.resolve(); });
  return host;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  document.body.replaceChildren();
});

const entry = (key: StageKeyEntry["key"], label: string, over: Partial<StageKeyEntry> = {}): StageKeyEntry => ({ key, label, tone: stageTone(key), pressed: true, disabled: false, ...over });

const ENTRIES: StageKeyEntry[] = [
  entry("awaiting_raw", "Awaiting RAW"),
  entry("raw_review", "RAW review"),
  entry("editing", "Editing", { pressed: false }),
  entry("edited_review", "Edited review"),
  entry("delivered", "Delivered"),
];

const chip = (host: HTMLElement, name: string) => {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === name);
  if (!found) throw new Error(`no chip named ${name}`);
  return found;
};

describe("StageKeyRow: the Stage key that doubles as a Stage filter (#916)", () => {
  it("is a labelled group with one chip per Stage, named by the Stage alone (no count)", async () => {
    const host = await mount(<StageKeyRow entries={ENTRIES} onToggle={() => {}} />);
    const group = host.querySelector('[role="group"]');
    expect(group?.getAttribute("aria-label")).toBe("Stage key");
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Awaiting RAW", "RAW review", "Editing", "Edited review", "Delivered"]);
  });

  it("reports which Stages the Filter shows as pressed", async () => {
    const host = await mount(<StageKeyRow entries={ENTRIES} onToggle={() => {}} />);
    expect(chip(host, "RAW review").getAttribute("aria-pressed")).toBe("true");
    expect(chip(host, "Editing").getAttribute("aria-pressed")).toBe("false");
  });

  it("hands the Stage to onToggle when a chip is pressed", async () => {
    const onToggle = vi.fn();
    const host = await mount(<StageKeyRow entries={ENTRIES} onToggle={onToggle} />);
    await act(async () => { chip(host, "Edited review").click(); });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith("edited_review");
  });

  it("disables a chip the Filter cannot toggle, and says to edit Stage in the Filter", async () => {
    const onToggle = vi.fn();
    const host = await mount(<StageKeyRow entries={[entry("editing", "Editing", { disabled: true })]} onToggle={onToggle} />);
    const button = chip(host, "Editing");
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe("Edit Stage in Filter");
    // The native tooltip still shows on hover, though a disabled button takes no pointer events.
    expect(button.parentElement?.getAttribute("title")).toBe("Edit Stage in Filter");
    await act(async () => { button.click(); });
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("draws each swatch from the Stage tone: its colour and its treatment", async () => {
    const host = await mount(<StageKeyRow entries={ENTRIES} onToggle={() => {}} />);
    const swatches = [...host.querySelectorAll<HTMLElement>('[data-testid="stage-key-swatch"]')];
    expect(swatches.map((swatch) => swatch.getAttribute("data-treatment"))).toEqual(["hollow-dashed", "solid", "solid", "solid", "wash"]);
    expect(swatches.map((swatch) => swatch.style.getPropertyValue("--swatch-color"))).toEqual(ENTRIES.map((item) => item.tone.color));
    for (const swatch of swatches) expect(swatch.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders the trailing slot after the chips", async () => {
    const host = await mount(<StageKeyRow entries={ENTRIES} onToggle={() => {}} trailing={<span data-testid="trailing">Colour by</span>} />);
    const group = host.querySelector('[role="group"]')!;
    const trailing = host.querySelector('[data-testid="trailing"]')!;
    expect(trailing.textContent).toBe("Colour by");
    expect(group.lastElementChild?.contains(trailing)).toBe(true);
  });
});
