import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { stageTone } from "../../lib/dashboard-appearance";
import { DoneProgress } from "./DoneProgress";
import { LateChip } from "./LateChip";
import { StageLabel } from "./StageLabel";

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
    await Promise.resolve();
  });
  return host;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  document.body.replaceChildren();
});

const byId = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

describe("LateChip", () => {
  it("prints its wording with the late colour", async () => {
    const host = await mount(<LateChip>2 days late</LateChip>);
    const chip = byId(host, "late-chip");
    expect(chip.textContent).toBe("2 days late");
    expect(chip.className).toContain("text-late");
  });
});

describe("StageLabel", () => {
  it("draws the swatch in the Stage tone beside the label", async () => {
    const host = await mount(<StageLabel stageKey="raw_review" label="RAW review" />);
    expect(byId(host, "stage-label").textContent).toBe("RAW review");
    const swatch = byId(host, "stage-key-swatch");
    expect(swatch.getAttribute("data-treatment")).toBe(stageTone("raw_review").treatment);
    expect(swatch.style.getPropertyValue("--swatch-color")).toBe(stageTone("raw_review").color);
  });

  it("adds the autoHDR variant for editing_autohdr only", async () => {
    const host = await mount(<StageLabel stageKey="editing_autohdr" label="Editing" />);
    expect(byId(host, "stage-label").textContent).toBe("Editing· autoHDR");
    expect(byId(host, "stage-label").getAttribute("data-stage")).toBe("editing");
    await act(async () => { root!.render(<StageLabel stageKey="editing" label="Editing" />); await Promise.resolve(); });
    expect(byId(host, "stage-label").textContent).toBe("Editing");
  });
});

describe("DoneProgress", () => {
  const tone = stageTone("editing");

  it("prints N of M done over a bar tinted to the tone", async () => {
    const host = await mount(<DoneProgress done={{ done: 2, total: 5, label: "2 of 5 done" }} tone={tone} known />);
    expect(byId(host, "done-progress").textContent).toContain("2 of 5 done");
    expect(byId(host, "done-progress").style.getPropertyValue("--progress-tone")).toBe(tone.color);
    expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("40");
  });

  it("says No tasks for a known empty checklist, and nothing for an unknown one", async () => {
    const host = await mount(<DoneProgress done={null} tone={tone} known />);
    expect(host.textContent).toBe("No tasks");
    await act(async () => { root!.render(<DoneProgress done={null} tone={tone} known={false} />); await Promise.resolve(); });
    expect(host.textContent).toBe("");
  });
});
