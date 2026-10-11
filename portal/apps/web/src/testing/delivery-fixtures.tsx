import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import type { DeliveryItemDto, DeliveryPageDto } from "@quincy/shared";

/** Shared setup for the Client Delivery DOM tests (#787 slice 9). */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

export const SLUG = "12-example-st-23456b";
export const BASE = `/d/api/pages/${SLUG}`;
export const handle = (n: number) => `h${String(n).padStart(15, "0")}`;
export const mediaUrl = (n: number) => `${BASE}/items/${handle(n)}/media`;
export const thumbUrl = (n: number) => `${BASE}/items/${handle(n)}/thumb`;
export const downloadUrl = (n: number) => `${BASE}/items/${handle(n)}/download`;
export const unlockUrl = (n: number) => `${BASE}/items/${handle(n)}/unlock-request`;

export const photo = (n: number, over: Partial<DeliveryItemDto> = {}): DeliveryItemDto => ({ handle: handle(n), kind: "photo", label: `Photo ${String(n).padStart(2, "0")}`, position: n, locked: false, premium: false, width: 6000, height: 4000, durationMs: null, url: mediaUrl(n), thumbUrl: thumbUrl(n), ...over });
export const locked = (n: number, over: Partial<DeliveryItemDto> = {}): DeliveryItemDto => photo(n, { locked: true, premium: true, ...over });
export const film = (n: number, over: Partial<DeliveryItemDto> = {}): DeliveryItemDto => ({ handle: handle(n), kind: "video", label: `Video ${String(n).padStart(2, "0")}`, position: n, locked: false, premium: false, width: 1920, height: 1080, durationMs: 62_000, url: mediaUrl(n), thumbUrl: thumbUrl(n), ...over });
export const pdf = (n: number, kind: "floorplan" | "copy", over: Partial<DeliveryItemDto> = {}): DeliveryItemDto => ({ handle: handle(n), kind, label: `${kind === "floorplan" ? "Floorplan" : "Copy"} ${String(n).padStart(2, "0")}`, position: n, locked: false, premium: false, width: null, height: null, durationMs: null, url: mediaUrl(n), thumbUrl: null, ...over });
export const page = (items: DeliveryItemDto[], over: Partial<DeliveryPageDto> = {}): DeliveryPageDto => ({ property: { street: "12 Example St", suburb: "Suburbia" }, setNumber: 1, publishedAt: Date.UTC(2026, 9, 10, 14, 30), coverHandle: null, items, ...over });

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
export const flush = async (times = 4) => { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); };

export type Mounted = { host: HTMLElement; root: Root; unmount: () => Promise<void> };
export async function render(element: React.ReactElement): Promise<Mounted> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(element); });
  return { host, root, unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}
export const click = async (element: Element | null | undefined) => { if (!element) throw new Error("click: no element"); await act(async () => { (element as HTMLElement).click(); }); };
export const press = async (key: string, target: Element = document.activeElement ?? document.body) => { await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); }); };
export const byTestId = (id: string, within: ParentNode = document) => within.querySelector<HTMLElement>(`[data-testid="${id}"]`);
export const allByTestId = (id: string, within: ParentNode = document) => [...within.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
export const byLabel = (label: string, within: ParentNode = document) => within.querySelector<HTMLElement>(`[aria-label="${label}"]`);
export const tab = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((element) => element.textContent === name) ?? null;
export const tabNames = () => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].map((element) => element.textContent);

type Listener = () => void;
export type FakeEmbla = {
  api: { scrollTo: ReturnType<typeof vi.fn>; selectedScrollSnap: () => number; on: (event: string, listener: Listener) => void; off: (event: string, listener: Listener) => void; scrollPrev: () => void; scrollNext: () => void; canScrollPrev: () => boolean; canScrollNext: () => boolean } | null;
  options: unknown;
  snap: number;
  /** A swipe: embla settles on `index` and reports `select`. */
  swipeTo(index: number): Promise<void>;
  /** Embla reporting an event of its own (`pointerUp`, the end of a drag) with the snap it will settle on. */
  emit(event: string, snap?: number): Promise<void>;
};
export const embla: FakeEmbla = { api: null, options: null, snap: 0, async swipeTo(index) { embla.snap = index; await act(async () => { listeners.get("select")?.forEach((listener) => listener()); }); },
  async emit(event, snap) { if (snap !== undefined) embla.snap = snap; await act(async () => { listeners.get(event)?.forEach((listener) => listener()); }); } };
const listeners = new Map<string, Set<Listener>>();
/** A stand-in for `embla-carousel-react`: happy-dom has no layout, so real embla has nothing to measure. The page's own index state is what the tests read; this records where the page told embla to go and lets a test report a swipe. */
export function fakeEmblaModule() {
  const useEmblaCarousel = (options: { startIndex?: number } = {}) => {
    const [api] = useState(() => {
      embla.snap = options.startIndex ?? 0; embla.options = options; listeners.clear();
      const fake = {
        scrollTo: vi.fn((index: number) => { embla.snap = index; }),
        selectedScrollSnap: () => embla.snap,
        on: (event: string, listener: Listener) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(listener); },
        off: (event: string, listener: Listener) => { listeners.get(event)?.delete(listener); },
        scrollPrev: () => undefined, scrollNext: () => undefined, canScrollPrev: () => true, canScrollNext: () => true,
      };
      embla.api = fake;
      return fake;
    });
    useEffect(() => () => { embla.api = null; }, []);
    return [() => undefined, api] as const;
  };
  return { default: useEmblaCarousel };
}

/** Flushes until `done()` holds (a lazy chunk's first import takes more than a few ticks), or fails after `tries`. */
export async function until(done: () => unknown, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i += 1) { if (done()) return; await flush(1); }
  throw new Error("until: condition never held");
}
