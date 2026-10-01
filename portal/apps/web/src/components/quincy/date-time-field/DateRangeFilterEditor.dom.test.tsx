import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilterEditorProps } from "@/components/reui/filters/filters-types";
import { DateRangeFilterEditor } from "./DateRangeFilterEditor";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean; IS_REACT_ACT_ENVIRONMENT_?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); document.body.replaceChildren(); });

function Editor({ initial, commit, cancel }: { initial?: string[]; commit: (value?: string | string[]) => void; cancel: () => void }) {
  const [value, setValue] = useState<string | string[] | undefined>(initial);
  const props = {
    field: { id: "shoot", label: "Shoot date" }, operator: { value: "between", label: "is between", arity: "range" }, value, onValueChange: setValue,
    host: "amend", autoFocusProps: { ref: () => undefined, autoFocus: false }, commit, cancel, back: () => undefined,
    options: {} as never, labels: {} as never,
  } as unknown as FilterEditorProps<string | string[], unknown>;
  return <DateRangeFilterEditor {...props} />;
}

const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === name)!;

describe("DateRangeFilterEditor (#429)", () => {
  it("disables Apply until a day is picked, and Cancel calls cancel", async () => {
    const cancel = vi.fn();
    const commit = vi.fn();
    await act(async () => { root.render(<Editor commit={commit} cancel={cancel} />); });
    expect(button("Apply").disabled).toBe(true);
    await act(async () => { button("Cancel").click(); });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it("applies an existing range as [from, to] civil days", async () => {
    const commit = vi.fn();
    await act(async () => { root.render(<Editor initial={["2026-08-03", "2026-08-07"]} commit={commit} cancel={() => undefined} />); });
    expect(button("Apply").disabled).toBe(false);
    await act(async () => { button("Apply").click(); });
    expect(commit).toHaveBeenCalledWith(["2026-08-03", "2026-08-07"]);
  });
});
