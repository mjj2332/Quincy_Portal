import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installLocalStorageShim } from "../testing/local-storage";
import { readUiPref, resetUiPrefMemory, uiPrefKey, useUiPref, writeUiPref } from "./ui-prefs";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const asNumber = (raw: unknown): number => (typeof raw === "number" && Number.isFinite(raw) ? raw : 7);
const memoryStorage = () => { const map = new Map<string, string>(); return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } }; };
const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };

let shim: ReturnType<typeof installLocalStorageShim>;
beforeEach(() => { shim = installLocalStorageShim(); resetUiPrefMemory(); });
afterEach(() => { shim.restore(); });

describe("ui prefs (#859)", () => {
  it("namespaces keys under quincy:ui:", () => { expect(uiPrefKey("review-notes-pane")).toBe("quincy:ui:review-notes-pane"); });

  it("reads through normalize: missing, junk and unparseable values all become the normalised default", () => {
    const storage = memoryStorage();
    expect(readUiPref("k", asNumber, storage)).toBe(7);
    storage.map.set("k", "not json{");
    expect(readUiPref("k", asNumber, storage)).toBe(7);
    storage.map.set("k", JSON.stringify("string"));
    expect(readUiPref("k", asNumber, storage)).toBe(7);
    storage.map.set("k", JSON.stringify(42));
    expect(readUiPref("k", asNumber, storage)).toBe(42);
  });

  it("writes JSON and swallows a storage that throws", () => {
    const storage = memoryStorage();
    writeUiPref("k", 5, asNumber, storage);
    expect(storage.map.get("k")).toBe("5");
    expect(() => writeUiPref("k", 5, asNumber, throwing)).not.toThrow();
    expect(readUiPref("k", asNumber, throwing)).toBe(5); // the choice stands in memory for the session
    expect(readUiPref("other", asNumber, throwing)).toBe(7);
  });

  describe("useUiPref", () => {
    let root: Root; let host: HTMLElement;
    beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
    afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

    function Reader({ id, name }: { id: string; name: string }) {
      const [value, set] = useUiPref(uiPrefKey(name), asNumber);
      return <button type="button" data-testid={id} onClick={() => { set(value + 1); }}>{value}</button>;
    }
    const text = (id: string) => host.querySelector(`[data-testid="${id}"]`)!.textContent;
    const click = async (id: string) => { await act(async () => { host.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.click(); }); };

    it("two readers of one key share a value in the same tab, and it persists", async () => {
      await act(async () => { root.render(<><Reader id="a" name="n" /><Reader id="b" name="n" /></>); });
      expect(text("a")).toBe("7");
      await click("a");
      expect(text("a")).toBe("8");
      expect(text("b")).toBe("8");
      expect(window.localStorage.getItem("quincy:ui:n")).toBe("8");
    });

    it("keeps the choice for the session when storage is blocked on write", async () => {
      shim.restore(); shim = installLocalStorageShim({ blockWrites: true });
      await act(async () => { root.render(<Reader id="a" name="blocked" />); });
      await click("a");
      expect(text("a")).toBe("8");
    });

    it("a setter captured for an old key is inert once the key changed (#431 rule)", async () => {
      let stale: ((n: number) => void) | null = null;
      function Probe({ name }: { name: string }) { const [, set] = useUiPref(uiPrefKey(name), asNumber); if (name === "one") stale = set; return null; }
      await act(async () => { root.render(<Probe name="one" />); });
      await act(async () => { root.render(<Probe name="two" />); });
      await act(async () => { stale!(99); });
      expect(window.localStorage.getItem("quincy:ui:one")).toBeNull();
      expect(window.localStorage.getItem("quincy:ui:two")).toBeNull();
    });
  });
});
