import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileDropzone, FilePickButton } from "./FileDropzone";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null; let host: HTMLElement | null = null;
async function mount(node: React.ReactNode) {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(node); });
  return host;
}
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); host?.remove(); root = null; host = null; });

const files = [new File(["a"], "a.mp4"), new File(["b"], "b.mov")];
async function choose(input: HTMLInputElement) {
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function drop(zone: Element) {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files } });
  await act(async () => { zone.dispatchEvent(event); });
}

describe("FilePickButton / FileDropzone", () => {
  it("multiple: the input is multiple and every picked file is passed on", async () => {
    const onFiles = vi.fn();
    const el = await mount(<FilePickButton accept=".mp4" multiple onFiles={onFiles}>Choose</FilePickButton>);
    const input = el.querySelector("input")!;
    expect(input.multiple).toBe(true);
    await choose(input);
    expect(onFiles).toHaveBeenCalledWith(files);
  });

  it("multiple: a drop passes every file", async () => {
    const onFiles = vi.fn();
    const el = await mount(<FileDropzone multiple onFiles={onFiles} data-testid="z">x</FileDropzone>);
    await drop(el.querySelector('[data-testid="z"]')!);
    expect(onFiles).toHaveBeenCalledWith(files);
  });

  it("single mode passes only the first file and the input is not multiple", async () => {
    const onFile = vi.fn();
    const el = await mount(<><FilePickButton accept=".mp4" onFile={onFile}>Choose</FilePickButton><FileDropzone onFile={onFile} data-testid="z">x</FileDropzone></>);
    expect(el.querySelector("input")!.multiple).toBe(false);
    await choose(el.querySelector("input")!);
    await drop(el.querySelector('[data-testid="z"]')!);
    expect(onFile).toHaveBeenCalledTimes(2);
    expect(onFile).toHaveBeenNthCalledWith(1, files[0]);
    expect(onFile).toHaveBeenNthCalledWith(2, files[0]);
  });
});
