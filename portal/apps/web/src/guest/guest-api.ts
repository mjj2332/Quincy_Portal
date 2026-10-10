import {
  guestNoteListResponseSchema, guestNoteMarkupResponseSchema, guestPasscodeErrorSchema, guestSessionResponseSchema, guestVideoListResponseSchema,
  type GuestNoteMarkupResponse, type GuestNoteThreadDto, type GuestSessionResponse, type GuestVideoDto,
} from "@quincy/shared";

/**
 * The guest page's own fetch wrapper (#741 12b). It is not `lib/api`: it carries no staff session, base URL or error type, only relative `/d/api/links/<linkId>/...` paths with
 * `credentials: "same-origin"`. Every response is parsed with the strict shared schema. The server answers every no-access outcome with the same stub, so a read that is not a 200
 * is `null` ("unavailable") and the page never tries to say why; a network failure reads the same way.
 */
export type ExchangeResult =
  | { ok: true; session: GuestSessionResponse }
  | { ok: false; reason: "passcode_required" | "passcode_incorrect" | "unavailable" }
  | { ok: false; reason: "limited"; retryAfterSeconds: number };

export type GuestApi = {
  exchange(token: string, passcode?: string): Promise<ExchangeResult>;
  session(): Promise<GuestSessionResponse | null>;
  videos(): Promise<GuestVideoDto[] | null>;
  notes(assetId: string): Promise<GuestNoteThreadDto[] | null>;
  markup(noteId: string): Promise<GuestNoteMarkupResponse | null>;
};

export function createGuestApi(linkId: string): GuestApi {
  const base = `/d/api/links/${linkId}`;
  const send = async (path: string, init?: RequestInit): Promise<Response | null> => {
    try { return await fetch(`${base}${path}`, { credentials: "same-origin", ...init }); } catch { return null; }
  };
  const read = async <T>(path: string, parse: (body: unknown) => T): Promise<T | null> => {
    const response = await send(path);
    if (!response?.ok) return null;
    try { return parse(await response.json()); } catch { return null; }
  };
  return {
    async exchange(token, passcode) {
      const response = await send("/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(passcode === undefined ? { token } : { token, passcode }) });
      if (!response) return { ok: false, reason: "unavailable" };
      if (response.ok) {
        try { return { ok: true, session: guestSessionResponseSchema.parse(await response.json()) }; } catch { return { ok: false, reason: "unavailable" }; }
      }
      if (response.status === 401 || response.status === 429) {
        const body = guestPasscodeErrorSchema.safeParse(await response.json().catch(() => null));
        if (body.success) return body.data.error === "too_many_attempts" ? { ok: false, reason: "limited", retryAfterSeconds: body.data.retryAfterSeconds } : { ok: false, reason: body.data.error };
      }
      return { ok: false, reason: "unavailable" };
    },
    session: () => read("/session", (body) => guestSessionResponseSchema.parse(body)),
    videos: async () => (await read("/videos", (body) => guestVideoListResponseSchema.parse(body)))?.videos ?? null,
    notes: async (assetId) => (await read(`/versions/${assetId}/notes`, (body) => guestNoteListResponseSchema.parse(body)))?.notes ?? null,
    markup: (noteId) => read(`/notes/${noteId}/markup`, (body) => guestNoteMarkupResponseSchema.parse(body)),
  };
}
