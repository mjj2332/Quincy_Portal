import {
  inspectOverlayPng, OVERLAY_PNG_MESSAGES, SOCIAL_OVERLAY_MAX_BYTES, type OverlayPngCode, type SocialOverlayDto,
} from "@quincy/shared";
import { ApiError, apiGet, apiPatch, apiPost, apiPostForm } from "./api";

/** Admin Social overlay library calls (#869). The server is authoritative; `checkOverlayFile` only gives instant copy before any request. */
const BASE = "/api/admin/social-overlays";
type OverlayResponse = { overlay: SocialOverlayDto };

export const listSocialOverlays = async (): Promise<SocialOverlayDto[]> => (await apiGet<{ overlays: SocialOverlayDto[] }>(BASE)).overlays;

export async function createSocialOverlay(input: { name: string; platformLabel: string; file: File }): Promise<SocialOverlayDto> {
  const form = new FormData();
  form.set("name", input.name); form.set("platformLabel", input.platformLabel); form.set("image", input.file);
  return (await apiPostForm<OverlayResponse>(BASE, form)).overlay;
}
export async function replaceSocialOverlayImage(overlay: SocialOverlayDto, file: File): Promise<SocialOverlayDto> {
  const form = new FormData();
  form.set("expectedRevision", String(overlay.revision)); form.set("image", file);
  return (await apiPostForm<OverlayResponse>(`${BASE}/${overlay.id}/image`, form)).overlay;
}
export async function renameSocialOverlay(overlay: SocialOverlayDto, input: { name: string; platformLabel: string }): Promise<SocialOverlayDto> {
  return (await apiPatch<OverlayResponse, unknown>(`${BASE}/${overlay.id}`, { ...input, expectedRevision: overlay.revision })).overlay;
}
export async function setSocialOverlayArchived(overlay: SocialOverlayDto, archived: boolean): Promise<SocialOverlayDto> {
  return (await apiPost<OverlayResponse, unknown>(`${BASE}/${overlay.id}/${archived ? "archive" : "unarchive"}`, { expectedRevision: overlay.revision })).overlay;
}

/** Refuses a file before upload: not a PNG by type or name, over the cap, or a PNG the shared inspector rejects. Returns the message to show, or null when the file looks fine. */
export async function checkOverlayFile(file: File): Promise<string | null> {
  if (file.type !== "image/png" && !/\.png$/i.test(file.name)) return OVERLAY_PNG_MESSAGES.not_png;
  if (file.size > SOCIAL_OVERLAY_MAX_BYTES) return "The PNG is larger than 8 MB.";
  const result = inspectOverlayPng(new Uint8Array(await file.arrayBuffer()));
  return result.ok ? null : OVERLAY_PNG_MESSAGES[result.code];
}

/** Friendly copy for a failed call: the server's PNG codes map to the same sentences as the pre-check. */
export function overlayErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const code = (error.details as { code?: unknown } | undefined)?.code;
    if (typeof code === "string" && code in OVERLAY_PNG_MESSAGES) return OVERLAY_PNG_MESSAGES[code as OverlayPngCode];
    if (code === "overlay_too_large") return "The PNG is larger than 8 MB.";
    if (code === "overlay_conflict") return "Someone else changed this overlay. Reload the list and try again.";
    return error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}
