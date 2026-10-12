import { deliveryPageDtoSchema, type DeliveryPageDto } from "@quincy/shared";
import type { DeliveryHrefs } from "./delivery-model";

/**
 * The Client Delivery page's own fetch wrapper (#787 slice 9), the only file in `delivery/` that calls `fetch` (`guest-boundary.guard.test.ts`). Like `guest/guest-api.ts` it is not `lib/api`: no staff session, base URL
 * or error type, only relative `/d/api/pages/<slug>/...` paths with `credentials: "omit"`. The page is public by address, so there is no cookie to send and nothing to leak by sending one.
 * The response is parsed with the strict shared schema; a body that does not parse means the server and this bundle disagree (a deploy in between), which is `outdated`, not `gone`.
 */
export type PageRead =
  | { kind: "ok"; dto: DeliveryPageDto }
  /** Unknown address, page off, unpublished, gate shut: one answer, so the page says nothing about which. */
  | { kind: "gone" }
  | { kind: "rateLimited"; retryAfterSeconds: number }
  | { kind: "transient" }
  | { kind: "outdated" };

export type UnlockResult =
  /** 202 `requested` or `already_requested`: the studio knows. */
  | { kind: "requested" }
  /** 409 `not_locked`: someone unlocked it meanwhile; the page re-reads. */
  | { kind: "notLocked" }
  | { kind: "limited"; retryAfterSeconds: number }
  | { kind: "gone" }
  | { kind: "failed" };

export type DeliveryApi = {
  hrefs: DeliveryHrefs;
  unlockRequestUrl(handle: string): string;
  /** An aborted read comes back `transient`; the caller checks its own signal and ignores it. */
  page(signal?: AbortSignal): Promise<PageRead>;
  requestUnlock(handle: string): Promise<UnlockResult>;
};

const DEFAULT_WAIT_SECONDS = 60;
function retryAfter(response: Response, body: unknown): number {
  const fromHeader = Number(response.headers.get("retry-after"));
  const fromBody = typeof body === "object" && body !== null && "retryAfterSeconds" in body ? Number((body as { retryAfterSeconds: unknown }).retryAfterSeconds) : Number.NaN;
  const seconds = Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : Number.isFinite(fromBody) && fromBody > 0 ? fromBody : DEFAULT_WAIT_SECONDS;
  return Math.ceil(seconds);
}
async function readBody(response: Response): Promise<{ body: unknown } | null> {
  try { return { body: await response.json() }; } catch { return null; }
}

export function createDeliveryApi(slug: string): DeliveryApi {
  const base = `/d/api/pages/${slug}`;
  const item = (handle: string, part: string) => `${base}/items/${handle}/${part}`;
  const send = async (url: string, init: RequestInit): Promise<Response | null> => {
    try { return await fetch(url, { credentials: "omit", ...init }); } catch { return null; }
  };
  return {
    hrefs: { media: (handle) => item(handle, "media"), thumb: (handle) => item(handle, "thumb"), download: (handle) => item(handle, "download") },
    unlockRequestUrl: (handle) => item(handle, "unlock-request"),
    async page(signal) {
      const response = await send(base, signal ? { signal } : {});
      if (response === null || response.status >= 500) return { kind: "transient" };
      if (response.status === 429) return { kind: "rateLimited", retryAfterSeconds: retryAfter(response, (await readBody(response))?.body) };
      if (!response.ok) return { kind: "gone" };
      const read = await readBody(response);
      if (read === null) return { kind: "transient" };
      const parsed = deliveryPageDtoSchema.safeParse(read.body);
      return parsed.success ? { kind: "ok", dto: parsed.data } : { kind: "outdated" };
    },
    async requestUnlock(handle) {
      const response = await send(item(handle, "unlock-request"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (response === null || response.status >= 500) return { kind: "failed" };
      const read = await readBody(response);
      if (response.status === 202) {
        const status = typeof read?.body === "object" && read.body !== null && "status" in read.body ? (read.body as { status: unknown }).status : undefined;
        return status === "requested" || status === "already_requested" ? { kind: "requested" } : { kind: "failed" };
      }
      if (response.status === 429) return { kind: "limited", retryAfterSeconds: retryAfter(response, read?.body) };
      if (response.status === 404) return { kind: "gone" };
      if (response.status === 409 && typeof read?.body === "object" && read.body !== null && (read.body as { error?: unknown }).error === "not_locked") return { kind: "notLocked" };
      return { kind: "failed" };
    },
  };
}
