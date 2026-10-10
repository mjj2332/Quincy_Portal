import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Role, VideoDto } from "@quincy/shared";
import { ApiError } from "../lib/api";
import { QuincyQueryProvider } from "../lib/query-client";
import { VideoCollectionPanel } from "../components/video/VideoCollectionPanel";

/** Fixtures and DOM helpers for the Review links suites (#741 11b). The API mocks stay in each suite (`vi.mock` is per file). */
export const USER = "44444444-4444-4444-8444-444444444444";
export const PROJECT = "11111111-1111-4111-8111-111111111111";
export const NOW = "2026-10-10T03:00:00Z"; // Sat 10 Oct, 14:00 Sydney (AEDT)
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const V1 = id(101); export const V2 = id(102); export const A1 = id(201); export const A2 = id(202); export const B1 = id(203); export const L1 = id(301); export const L2 = id(302); export const L3 = id(303);
export const mia = { id: id(901), name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true };
export const versionOf = (assetId: string, version: number, current: boolean) => ({ assetId, version, current, uploadedBy: mia, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "film.mp4", bytes: 100, fps: { num: 25, den: 1 }, frameCount: 300, durationMs: 134000, width: 1920, height: 1080, codec: "avc1", startTimecodeFrames: null, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: false, hasPoster: false, streamUrl: `/media/video/${assetId}`, posterUrl: null });
export const videoOf = (videoId: string, title: string, versions: Array<[string, number, boolean]>): VideoDto => ({ id: videoId, title, premium: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: versions.find(([, , current]) => current)![0], latestNoteCount: null, uploading: null, versions: versions.map(([a, n, c]) => versionOf(a, n, c)) }) as VideoDto;
export const WALK = videoOf(V1, "Main walkthrough", [[A2, 2, true], [A1, 1, false]]);
export const TEASER = videoOf(V2, "Teaser", [[B1, 1, true]]);
export type LinkOver = Partial<{ id: string; label: string | null; status: string; expiresAt: string; revokedAt: string | null; hasPasscode: boolean; allow: { comments: boolean; approve: boolean; download: boolean }; videos: unknown[]; activity: unknown }>;
export const member = (videoId: string, title: string, grants: Array<[string, number]>) => ({ videoId, title, addedAt: "2026-10-09T02:00:00.000Z", grants: grants.map(([assetId, version]) => ({ assetId, version })) });
export const linkOf = (over: LinkOver = {}) => ({ id: L1, label: "Smith family", status: "active", createdAt: "2026-10-09T02:00:00.000Z", createdBy: mia, expiresAt: "2026-11-09T12:59:00.000Z", revokedAt: null, revokedBy: null, hasPasscode: false, allow: { comments: true, approve: true, download: true }, videos: [member(V1, "Main walkthrough", [[A2, 2]])], activity: { openSessions: 0, lastOpenedAt: null, verifiedGuests: [] }, ...over });

/** What the mocked API answers; tests reassign the fields. */
export const state: { links: unknown[]; videos: VideoDto[] } = { links: [], videos: [WALK, TEASER] };
let root: Root | null = null; let host: HTMLElement;
export async function flush(times = 8) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
export async function mount(options: { parts?: string[]; role?: Role; archived?: boolean } = {}) {
  const { parts = ["upload", "links"], role = "editor", archived = false } = options;
  if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => { root!.render(<><QuincyQueryProvider principalId={USER} role={role}><VideoCollectionPanel projectId={PROJECT} role={role} archived={archived} review={{ open: true, parts: parts as never }} /></QuincyQueryProvider></>); });
  await flush();
}
export async function unmount() { if (root) await act(async () => { root!.unmount(); }); root = null; }

export const q = <T extends Element = HTMLElement>(selector: string, scope: ParentNode | null = document) => scope === null ? null : scope.querySelector<T>(selector);
export const all = <T extends Element = HTMLElement>(selector: string, scope: ParentNode | null = document) => scope === null ? [] : [...scope.querySelectorAll<T>(selector)];
export const dialog = () => q('[data-testid="review-links-dialog"]');
export const alertDialog = () => q('[data-slot="alert-dialog-content"]');
export const buttonIn = (scope: ParentNode | null, label: string | RegExp) => all<HTMLButtonElement>("button", scope ?? document).find((b) => { const name = b.getAttribute("aria-label") ?? b.textContent ?? ""; return typeof label === "string" ? name === label || b.textContent === label : label.test(name) || label.test(b.textContent ?? ""); });
export const button = (label: string | RegExp) => buttonIn(document, label);
export async function press(el: Element | null | undefined) { if (!el) throw new Error("nothing to press"); await act(async () => { (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); }); await flush(); }
export async function type(el: HTMLInputElement | null, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value); el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush(2);
}
export const checkbox = (name: string, scope: ParentNode | null = document) => q<HTMLInputElement>(`input[type="checkbox"][aria-label="${name}"]`, scope);
export const toggle = (name: string, scope: ParentNode | null = document) => q<HTMLElement>(`[role="switch"][aria-label="${name}"]`, scope);
export const text = (scope: ParentNode | null = document) => scope?.textContent ?? "";
export const refused = (status: number, body: Record<string, unknown>) => new ApiError(String(body.error), status, body);

export async function openList() { await press(q('[data-testid="review-links-open"]')); }
export async function openDetailOf(label: string) { await openList(); await press(button(`Manage ${label}`)); }
export async function selectFilms(...titles: string[]) { for (const title of titles) await press(checkbox(`Select ${title}`)); }

