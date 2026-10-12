import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { RichTextDoc } from "@quincy/shared";
import type { Editor } from "@tiptap/react";
import { QuincyRichTextEditorBase } from "./QuincyRichTextEditorBase";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const empty = (): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph" }] });
let root: Root | null = null;
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren(); });

const field = (preset: "composer" | "document", onChange: () => void) => <QuincyRichTextEditorBase preset={preset} value={empty()} onChange={onChange} limit={2_000} />;

/**
 * The editor is a lazy chunk on a Review link and in the staff lightbox (#835). React disconnects a revealed Suspense tree's effects and
 * reconnects them; Tiptap's `useEditor` destroys its editor a tick after the disconnect and builds another on reconnect. The render and
 * the effects that React replays still hold the destroyed one, and reading its view threw "The editor view is not available" (the page went blank).
 */
describe("QuincyRichTextEditorBase when Tiptap has destroyed its editor under it", () => {
  for (const preset of ["composer", "document"] as const) {
    it(`${preset}: re-renders and unmounts without throwing, and ends with a live editor`, async () => {
      const errors: unknown[] = [];
      const onError = (event: ErrorEvent) => { errors.push(event.error); event.preventDefault(); };
      window.addEventListener("error", onError);
      const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
      await act(async () => { root!.render(field(preset, () => undefined)); await new Promise((resolve) => setTimeout(resolve, 20)); });
      const first = (host.querySelector('[contenteditable="true"]') as (HTMLElement & { editor?: Editor }) | null)?.editor;
      expect(first).toBeDefined();
      await act(async () => { first!.destroy(); await Promise.resolve(); });
      await act(async () => { root!.render(field(preset, () => undefined)); await new Promise((resolve) => setTimeout(resolve, 50)); });
      window.removeEventListener("error", onError);
      expect(errors).toEqual([]);
      const live = (host.querySelector('[contenteditable="true"]') as (HTMLElement & { editor?: Editor }) | null)?.editor;
      expect(live).toBeDefined();
      expect(live!.isDestroyed).toBe(false);
    });
  }
});
