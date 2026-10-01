import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Frame,
  FrameDescription,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "./frame";

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(value: ReactNode) {
  await act(async () => { root!.render(value); });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host.remove();
});

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`)!;

describe("Frame / FramePanel", () => {
  it("renders the frame, its panel, header, title, description and footer", async () => {
    await render(
      <Frame data-testid="frame">
        <FramePanel data-testid="panel">
          <FrameHeader data-testid="header">
            <FrameTitle data-testid="title">Projects</FrameTitle>
            <FrameDescription data-testid="description">All active shoots</FrameDescription>
          </FrameHeader>
          <p>Body content</p>
          <FrameFooter data-testid="footer">Updated today</FrameFooter>
        </FramePanel>
      </Frame>,
    );
    expect(q("frame").contains(q("panel"))).toBe(true);
    // header/footer are real landmark-bearing elements, not generic divs
    expect(q("header").tagName).toBe("HEADER");
    expect(q("footer").tagName).toBe("FOOTER");
    expect(q("title").textContent).toBe("Projects");
    expect(q("description").textContent).toBe("All active shoots");
    expect(q("panel").textContent).toContain("Body content");
    expect(q("footer").textContent).toBe("Updated today");
  });

  it("passes DOM props through to the frame and panel", async () => {
    await render(
      <Frame data-testid="frame" aria-label="Frame label">
        <FramePanel data-testid="panel" role="region" aria-label="Panel label" fit />
      </Frame>,
    );
    expect(q("frame").getAttribute("aria-label")).toBe("Frame label");
    expect(q("panel").getAttribute("aria-label")).toBe("Panel label");
  });

  it("exposes the default spacing when spacing is omitted", async () => {
    await render(
      <>
        <Frame data-testid="implicit" />
        <Frame data-testid="explicit" spacing="default" />
        <Frame data-testid="small" spacing="sm" />
      </>,
    );
    // the panel-margin selectors key off data-spacing; omitted must equal the cva default
    expect(q("implicit").getAttribute("data-spacing")).toBe("default");
    expect(q("implicit").getAttribute("data-spacing")).toBe(q("explicit").getAttribute("data-spacing"));
    expect(q("small").getAttribute("data-spacing")).toBe("sm");
  });

  // Computed radius/border/background are NOT asserted here: happy-dom loads no stylesheet, so a
  // custom property never resolves. That chain (frame.tsx -> --frame-* -> Quincy token) is
  // covered by styles/frame-token-bridge.guard.test.ts.
});
