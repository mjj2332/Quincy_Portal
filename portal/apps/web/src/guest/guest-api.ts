import {
  guestEmailCodeErrorSchema, guestEmailCodeResponseSchema, guestNoteConflictSchema, guestNoteDeleteResponseSchema, guestNoteListResponseSchema, guestNoteMarkupResponseSchema, guestNoteWriteResponseSchema,
  guestPasscodeErrorSchema, guestSessionResponseSchema, guestVideoListResponseSchema,
  type GuestNoteCreateInput, type GuestNoteEditInput, type GuestNoteMarkupResponse, type GuestNoteThreadDto, type GuestSessionResponse, type GuestVideoDto,
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

/** `POST .../email/code`. A well-formed address is always 202 (no oracle); `limited` carries the server's retry time. */
export type SendCodeResult =
  | { ok: true; resendAfterSeconds: number }
  | { ok: false; reason: "invalid" | "gone" | "archived" | "unreachable" }
  | { ok: false; reason: "limited"; retryAfterSeconds: number };

/** `POST .../email/verify`. The 200 body is the new session (the cookie rotated server-side); `code_incorrect` says how many tries are left. */
export type VerifyResult =
  | { ok: true; session: GuestSessionResponse }
  | { ok: false; reason: "code_expired" | "already_verified" | "invalid" | "gone" | "archived" | "unreachable" }
  | { ok: false; reason: "code_incorrect"; attemptsLeft: number }
  | { ok: false; reason: "limited"; retryAfterSeconds: number };

/**
 * A guest note write (#741 13c). `ok.thread` is the root thread in the guest projection (null after a hard delete of a root). `conflict` and `deleted` (409) carry or imply fresh state;
 * `unverified` is 401 (the session lost its verification: verify again); `gone` is the stub or a switched-off part (the page's unavailable path); `archived` is 409 `project_archived`;
 * `rejected` is every other refusal of the request itself (400, 403 `not_author`, 413, 422).
 */
export type WriteResult =
  | { kind: "ok"; thread: GuestNoteThreadDto | null }
  | { kind: "conflict"; thread: GuestNoteThreadDto }
  | { kind: "deleted" }
  | { kind: "unverified" }
  | { kind: "gone" }
  | { kind: "archived" }
  | { kind: "limited"; retryAfterSeconds: number }
  | { kind: "rejected"; error: string }
  | { kind: "unreachable" };

export type GuestApi = {
  exchange(token: string, passcode?: string): Promise<ExchangeResult>;
  session(): Promise<Read<GuestSessionResponse>>;
  videos(): Promise<Read<GuestVideoDto[]>>;
  notes(assetId: string): Promise<Read<GuestNoteThreadDto[]>>;
  markup(noteId: string): Promise<Read<GuestNoteMarkupResponse>>;
  sendCode(email: string): Promise<SendCodeResult>;
  verifyCode(code: string, name: string): Promise<VerifyResult>;
  createNote(assetId: string, input: GuestNoteCreateInput): Promise<WriteResult>;
  replyToNote(noteId: string, body: string): Promise<WriteResult>;
  editNote(noteId: string, input: GuestNoteEditInput): Promise<WriteResult>;
  deleteNote(noteId: string, expectedRevision: number): Promise<WriteResult>;
};

export function createGuestApi(linkId: string): GuestApi {
  const base = `/d/api/links/${linkId}`;
  const send = async (path: string, init?: RequestInit): Promise<Response | null> => {
    try { return await fetch(`${base}${path}`, { credentials: "same-origin", ...init }); } catch { return null; }
  };
  /** The one place a body is read. A rejection (the connection dropped after the headers) says nothing about the link, so callers treat `null` as transient; only a body that read and then failed its schema is `gone`. */
  const readJson = async (response: Response): Promise<{ body: unknown } | null> => {
    try { return { body: await response.json() }; } catch { return null; }
  };
  const transient = (response: Response | null) => response === null || response.status >= 500 || response.status === 429;
  const read = async <T>(path: string, parse: (body: unknown) => T): Promise<Read<T>> => {
    const response = await send(path);
    if (transient(response)) return { kind: "transient" };
    if (!response?.ok) return { kind: "gone" };
    const read = await readJson(response);
    if (read === null) return { kind: "transient" };
    try { return { kind: "ok", value: parse(read.body) }; } catch { return { kind: "gone" }; }
  };
  const JSON_HEADERS = { "content-type": "application/json" };
  const retryAfter = (response: Response, body: unknown): number => {
    const fromBody = typeof body === "object" && body !== null && "retryAfterSeconds" in body ? Number((body as { retryAfterSeconds: unknown }).retryAfterSeconds) : Number.NaN;
    const fromHeader = Number(response.headers.get("retry-after"));
    const seconds = Number.isFinite(fromBody) && fromBody > 0 ? fromBody : Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : 60;
    return Math.ceil(seconds);
  };
  const errorOf = (body: unknown): string => (typeof body === "object" && body !== null && "error" in body && typeof (body as { error: unknown }).error === "string" ? (body as { error: string }).error : "invalid_request");
  /** The shared reading of a write's answer. `parseOk` reads the success body; everything else is the same for every note write. */
  const write = async (path: string, method: string, body: unknown, parseOk: (body: unknown) => GuestNoteThreadDto | null): Promise<WriteResult> => {
    const response = await send(path, { method, headers: JSON_HEADERS, body: JSON.stringify(body) });
    if (response === null) return { kind: "unreachable" };
    const read = await readJson(response);
    const parsedBody = read === null ? undefined : read.body;
    if (response.ok) {
      if (read === null) return { kind: "unreachable" };
      try { return { kind: "ok", thread: parseOk(read.body) }; } catch { return { kind: "unreachable" }; }
    }
    const error = errorOf(parsedBody);
    if (response.status >= 500) return { kind: "unreachable" };
    if (response.status === 429) return { kind: "limited", retryAfterSeconds: retryAfter(response, parsedBody) };
    if (response.status === 401) return { kind: "unverified" };
    if (response.status === 404 || (response.status === 403 && error !== "not_author")) return { kind: "gone" };
    if (response.status === 409) {
      if (error === "project_archived") return { kind: "archived" };
      if (error === "note_deleted") return { kind: "deleted" };
      const conflict = guestNoteConflictSchema.safeParse(parsedBody);
      if (conflict.success) return { kind: "conflict", thread: conflict.data.thread };
    }
    return { kind: "rejected", error };
  };
  return {
    async sendCode(email) {
      const response = await send("/email/code", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ email }) });
      if (response === null) return { ok: false, reason: "unreachable" };
      const read = await readJson(response);
      if (response.status === 202 || response.ok) {
        const parsed = read === null ? null : guestEmailCodeResponseSchema.safeParse(read.body);
        return parsed?.success ? { ok: true, resendAfterSeconds: parsed.data.resendAfterSeconds } : { ok: false, reason: "unreachable" };
      }
      if (response.status === 429) return { ok: false, reason: "limited", retryAfterSeconds: retryAfter(response, read?.body) };
      if (response.status >= 500) return { ok: false, reason: "unreachable" };
      if (response.status === 400) return { ok: false, reason: "invalid" };
      if (response.status === 409 && errorOf(read?.body) === "project_archived") return { ok: false, reason: "archived" };
      return { ok: false, reason: "gone" };
    },
    async verifyCode(code, name) {
      const response = await send("/email/verify", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ code, name }) });
      if (response === null) return { ok: false, reason: "unreachable" };
      const read = await readJson(response);
      if (response.ok) {
        const parsed = read === null ? null : guestSessionResponseSchema.safeParse(read.body);
        return parsed?.success ? { ok: true, session: parsed.data } : { ok: false, reason: "unreachable" };
      }
      if (response.status >= 500) return { ok: false, reason: "unreachable" };
      if (response.status === 429) return { ok: false, reason: "limited", retryAfterSeconds: retryAfter(response, read?.body) };
      if (response.status === 400) return { ok: false, reason: "invalid" };
      if (response.status === 409 && errorOf(read?.body) === "project_archived") return { ok: false, reason: "archived" };
      const parsed = read === null ? null : guestEmailCodeErrorSchema.safeParse(read.body);
      if (parsed?.success && response.status !== 404) {
        if (parsed.data.error === "code_incorrect") return { ok: false, reason: "code_incorrect", attemptsLeft: parsed.data.attemptsLeft };
        if (parsed.data.error === "code_expired" || parsed.data.error === "already_verified") return { ok: false, reason: parsed.data.error };
      }
      return { ok: false, reason: "gone" };
    },
    createNote: (assetId, input) => write(`/versions/${assetId}/notes`, "POST", input, (body) => guestNoteWriteResponseSchema.parse(body)),
    replyToNote: (noteId, body) => write(`/notes/${noteId}/replies`, "POST", { body }, (parsed) => guestNoteWriteResponseSchema.parse(parsed)),
    editNote: (noteId, input) => write(`/notes/${noteId}`, "PATCH", input, (body) => guestNoteWriteResponseSchema.parse(body)),
    deleteNote: (noteId, expectedRevision) => write(`/notes/${noteId}`, "DELETE", { expectedRevision }, (body) => guestNoteDeleteResponseSchema.parse(body).thread),
    async exchange(token, passcode) {
      const response = await send("/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(passcode === undefined ? { token } : { token, passcode }) });
      if (response === null) return { ok: false, reason: "unreachable" };
      if (response.ok) {
        const read = await readJson(response);
        if (read === null) return { ok: false, reason: "unreachable" };
        const parsed = guestSessionResponseSchema.safeParse(read.body);
        return parsed.success ? { ok: true, session: parsed.data } : { ok: false, reason: "unavailable" };
      }
      if (response.status === 401 || response.status === 429) {
        const read = await readJson(response);
        if (read === null) return { ok: false, reason: "unreachable" };
        const body = guestPasscodeErrorSchema.safeParse(read.body);
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
