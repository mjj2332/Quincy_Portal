import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCompareStore } from "../../lib/video-compare-store";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { mockViewport, type MockViewport } from "../../testing/viewport";
import { fixtureVersion, fixtureVideo } from "../../testing/video-trash-fixtures";
import { QuincyQueryProvider } from "../../lib/query-client";
import { VideoReviewViewer } from "./VideoReviewViewer";
import "../../testing/dom-polyfills";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("../../lib/video-poster", () => ({ captureVideoPoster: () => Promise.resolve(null) }));

const A = { v2: "77777777-7777-4777-8777-777777777777", v1: "66666666-6666-4666-8666-666666666666" };
const B = { v2: "55555555-5555-4555-8555-555555555555", v1: "44444444-4444-4444-8444-444444444444" };
let stub: VideoElementStub; let viewport: MockViewport; let root: Root | null = null;
beforeEach(() => { stub = installVideoElementStub(); viewport = mockViewport({ width: 1440 }); });
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; stub.dispose(); viewport.restore(); document.body.replaceChildren(); });

describe("the compare pair of another film (#776 E round 5)", () => {
  it("survives opening a different film's viewer: its Versions are not gone, they are just not this film's", async () => {
    const store = createCompareStore("project-776");
    store.setPair(A.v2, A.v1);
    store.setOffset(7);
    const filmB = fixtureVideo({ id: "88888888-8888-4888-8888-888888888888", title: "Film B", versions: [fixtureVersion({ assetId: B.v2, version: 2 }), fixtureVersion({ assetId: B.v1, version: 1 })] });
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<QuincyQueryProvider principalId="44444444-4444-4444-8444-444444444444" role="admin"><VideoReviewViewer video={filmB} onClose={() => {}} compare={{ store }} /></QuincyQueryProvider>); });
    await act(async () => { await Promise.resolve(); });
    expect(store.getState().pair).toEqual({ a: A.v2, b: A.v1 });
    expect(store.getState().offsets).toEqual({ [`${A.v2}:${A.v1}`]: 7 });
  });
});
