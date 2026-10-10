import {
  guestNoteListResponseSchema, guestNoteMarkupResponseSchema, guestPasscodeErrorSchema, guestSessionResponseSchema, guestVideoListResponseSchema,
  type GuestNoteMarkupResponse, type GuestNoteThreadDto, type GuestSessionResponse, type GuestVideoDto,
} from "@quincy/shared";

/**
 * The guest page's own fetch wrapper (#741 12b). It is not `lib/api`: it carries no staff session, base URL or error type, only relative `/d/api/links/<linkId>/...` paths with
 * `credentials: "same-origin"`. Every response is parsed with the strict shared schema. The server answers every no-access outcome with the same stub, so a read that is a 4xx
 * (404, a lost 401 session) is `gone` and the page never tries to say why. A network failure, a 5xx or a 429 is `transient`: it says nothing about the link, so the page offers a retry.
 */
export type Read<T> = { kind: "ok"; value: T } | { kind: "gone" } | { kind: "transient" };

export type ExchangeResult =
  | { ok: true; session: GuestSessionResponse }
  | { ok: false; reason: "passcode_required" | "passcode_incorrect" | "invalid_input" | "unavailable" | "unreachable" }
  | { ok: false; reason: "limited"; retryAfterSeconds: number };

export type GuestApi = {
  exchange(token: string, passcode?: string): Promise<ExchangeResult>;
  session(): Promise<Read<GuestSessionResponse>>;
  videos(): Promise<Read<GuestVideoDto[]>>;
  notes(assetId: string): Promise<Read<GuestNoteThreadDto[]>>;
  markup(noteId: string): Promise<Read<GuestNoteMarkupResponse>>;
};

export function createGuestApi(linkId: string): GuestApi {
  const base = `/d/api/links/${linkId}`;
  const send = async (path: string, init?: RequestInit): Promise<Response | null> => {
    try { return await fetch(`${base}${path}`, { credentials: "same-origin", ...init }); } catch { return null; }
  };
  const transient = (response: Response | null) => response === null || response.status >= 500 || response.status === 429;
  const read = async <T>(path: string, parse: (body: unknown) => T): Promise<Read<T>> => {
    const response = await send(path);
    if (transient(response)) return { kind: "transient" };
    if (!response?.ok) return { kind: "gone" };
    try { return { kind: "ok", value: parse(await response.json()) }; } catch { return { kind: "gone" }; }
  };
  return {
    async exchange(token, passcode) {
      const response = await send("/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(passcode === undefined ? { token } : { token, passcode }) });
      if (response === null) return { ok: false, reason: "unreachable" };
      if (response.ok) {
        try { return { ok: true, session: guestSessionResponseSchema.parse(await response.json()) }; } catch { return { ok: false, reason: "unavailable" }; }
      }
      if (response.status === 401 || response.status === 429) {
        const body = guestPasscodeErrorSchema.safeParse(await response.json().catch(() => null));
        if (body.success) return body.data.error === "too_many_attempts" ? { ok: false, reason: "limited", retryAfterSeconds: body.data.retryAfterSeconds } : { ok: false, reason: body.data.error };
      }
      if (response.status === 400 && passcode !== undefined) return { ok: false, reason: "invalid_input" };
      if (response.status >= 500 || response.status === 429) return { ok: false, reason: "unreachable" };
      return { ok: false, reason: "unavailable" };
    },
    session: () => read("/session", (body) => guestSessionResponseSchema.parse(body)),
    videos: () => read("/videos", (body) => guestVideoListResponseSchema.parse(body).videos),
    notes: (assetId) => read(`/versions/${assetId}/notes`, (body) => guestNoteListResponseSchema.parse(body).notes),
    markup: (noteId) => read(`/notes/${noteId}/markup`, (body) => guestNoteMarkupResponseSchema.parse(body)),
  };
}
