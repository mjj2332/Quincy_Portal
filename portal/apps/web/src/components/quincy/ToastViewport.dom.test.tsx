/**
 * ToastViewport — issue #110. In-tree, no portal, no provider: `useSyncExternalStore` against the
 * module-level `toast-store`. Query only by `data-testid`, role, or inline text literals — see
 * `testing/test-seam.guard.test.ts`.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { ToastViewport } from "./ToastViewport";
import { clearToasts, pushToast } from "../../lib/toast-store";

/**
 * Line-preserving strip, mirrored verbatim from `testing/test-seam.guard.test.ts` — see that
 * file's comment for why comments are stripped before matching (a grep gate that matches its own
 * explanatory comment, twice in two releases per `docs/lessons.md`).
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => "\n".repeat((match.match(/\n/g) ?? []).length))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

async function mount(node: React.ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(node); await Promise.resolve(); });
  return host;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  host?.remove();
  root = undefined;
  host = undefined;
  clearToasts();
});

describe("ToastViewport", () => {
  it("renders with aria-live=\"polite\" and zero toasts", async () => {
    const container = await mount(<ToastViewport />);
    const viewport = container.querySelector('[data-testid="toast-viewport"]');
    expect(viewport).not.toBeNull();
    expect(viewport?.getAttribute("aria-live")).toBe("polite");
    expect(container.querySelectorAll('[data-testid="toast"]')).toHaveLength(0);
  });

  it("shows a pushed toast with the right data-tone", async () => {
    const container = await mount(<ToastViewport />);
    await act(async () => { pushToast("Saved", "success"); await Promise.resolve(); });
    await flush();
    const toastNode = container.querySelector('[data-testid="toast"]');
    expect(toastNode?.textContent).toContain("Saved");
    expect(toastNode?.getAttribute("data-tone")).toBe("success");

    await act(async () => { pushToast("Broke", "error"); await Promise.resolve(); });
    await flush();
    const toastNodes = [...container.querySelectorAll('[data-testid="toast"]')];
    const errorNode = toastNodes.find((node) => node.textContent?.includes("Broke"));
    expect(errorNode?.getAttribute("data-tone")).toBe("error");
  });

  it("marks an announcedElsewhere toast aria-hidden while the container stays aria-live polite", async () => {
    const container = await mount(<ToastViewport />);
    await act(async () => { pushToast("Silent success", "success", { announcedElsewhere: true }); await Promise.resolve(); });
    await flush();
    const viewport = container.querySelector('[data-testid="toast-viewport"]');
    expect(viewport?.getAttribute("aria-live")).toBe("polite");
    const toastNode = container.querySelector('[data-testid="toast"]');
    expect(toastNode?.getAttribute("aria-hidden")).toBe("true");
  });

  it("leaves an ordinary (non-announcedElsewhere) toast without an aria-hidden attribute, inside a container that is aria-live polite (#110 fix round item 4)", async () => {
    const container = await mount(<ToastViewport />);
    await act(async () => { pushToast("Plain success"); await Promise.resolve(); });
    await flush();
    const viewport = container.querySelector('[data-testid="toast-viewport"]');
    expect(viewport?.getAttribute("aria-live")).toBe("polite");
    const toastNode = container.querySelector('[data-testid="toast"]');
    expect(toastNode?.hasAttribute("aria-hidden")).toBe(false);
  });

  it("renders the toast as a descendant of the host container — no portal", async () => {
    const container = await mount(<ToastViewport />);
    await act(async () => { pushToast("In the tree"); await Promise.resolve(); });
    await flush();
    const toastNode = container.querySelector('[data-testid="toast"]');
    expect(toastNode).not.toBeNull();
    expect(container.contains(toastNode)).toBe(true);
  });

  it("honours custom testId and toastTestId", async () => {
    const container = await mount(<ToastViewport testId="custom-viewport" toastTestId="custom-toast" />);
    await act(async () => { pushToast("Custom"); await Promise.resolve(); });
    await flush();
    expect(container.querySelector('[data-testid="custom-viewport"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="custom-toast"]')?.textContent).toContain("Custom");
    expect(container.querySelector('[data-testid="toast-viewport"]')).toBeNull();
    expect(container.querySelector('[data-testid="toast"]')).toBeNull();
  });

  it("does not leak a toast pushed after the last viewport unmounted into the next screen's viewport (#110 fix round item 1)", async () => {
    await mount(<ToastViewport />);
    await act(async () => { root!.unmount(); await Promise.resolve(); });
    host!.remove();
    root = undefined;
    host = undefined;

    await act(async () => { pushToast("An old project's error"); await Promise.resolve(); });
    await flush();

    const second = await mount(<ToastViewport />);
    expect(second.querySelectorAll('[data-testid="toast"]')).toHaveLength(0);
  });

  it("is rendered by exactly Dashboard.tsx, Admin.tsx and ProjectWorkspace.tsx, once each, and nowhere else", () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const counts: Record<string, number> = {};
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (entry.name.includes(".test.")) continue;
        // Comments stripped first: a grep gate that matches its own explanatory comment is a bug
        // this repo has shipped before (docs/lessons.md). Mirrors stripComments in
        // testing/test-seam.guard.test.ts.
        const source = stripComments(readFileSync(full, "utf8"));
        const occurrences = source.match(/<ToastViewport\b/g)?.length ?? 0;
        if (occurrences > 0) counts[relative(srcDir, full).split("\\").join("/")] = occurrences;
      }
    };
    walk(srcDir);
    // An exact map, not a Set of filenames: a Set discards multiplicity, so a second
    // `<ToastViewport />` added to a screen that already renders one would still pass — precisely
    // the duplicate-render, double-announce failure this test exists to prevent (#110 fix round
    // item 2).
    expect(counts).toEqual({
      "screens/Dashboard.tsx": 1,
      "screens/Admin.tsx": 1,
      "screens/ProjectWorkspace.tsx": 1,
    });
  });
});
