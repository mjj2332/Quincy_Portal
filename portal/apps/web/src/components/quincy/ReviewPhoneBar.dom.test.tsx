import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReviewPhoneBar } from "./ReviewPhoneBar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The phone review header's title column (#879 PR 3a round 2). P1/P2 always lead with a 44px back control; a guest on a single-video link has none, and the bar's `--space-1` gutter
 * alone left the title about 4pt from the screen edge. With no leading control the column takes a start inset; with one it stays as it was.
 */
let root: Root | null = null; let host: HTMLElement;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren(); });

const column = () => document.querySelector<HTMLElement>('[data-testid="review-phone-bar-title"]')!;
const render = (back: ReactNode) => act(async () => { root!.render(<ReviewPhoneBar back={back} title={<h1>Film</h1>} chip={<span>v3</span>} />); });

describe("ReviewPhoneBar title column (#879 PR 3a round 2)", () => {
  it("with no back control, the title column is inset from the bar's edge", async () => {
    await render(null);
    expect(column().className).toContain("ps-[var(--space-3)]");
  });

  it("with a back control, the title column has no inset of its own (staff unchanged)", async () => {
    await render(<button type="button">Back</button>);
    expect(column().className).not.toContain("ps-[");
  });
});
