import {
  guestArchivePrepareResponseSchema, guestDecisionResponseSchema, guestDownloadManifestSchema, guestEmailCodeErrorSchema, guestEmailCodeResponseSchema, guestNoteConflictSchema, guestNoteDeleteResponseSchema, guestNoteListResponseSchema, guestNoteMarkupResponseSchema, guestNotePasteCommitResponseSchema,
  guestNotePastePreviewResponseSchema, guestNotePasteStaleSchema, guestNoteWriteResponseSchema, guestPasscodeErrorSchema, guestSessionResponseSchema, guestSubscriptionResponseSchema, guestVideoListResponseSchema,
  type GuestArchivePrepareResponse, type GuestDecision, type GuestDecisionInput, type GuestDownloadManifest, type GuestNoteCreateInput, type GuestNoteEditInput, type GuestNoteMarkupResponse, type GuestNotePasteCommitInput, type GuestNotePasteCommitResponse,
  type GuestNotePastePreviewInput, type GuestNotePastePreviewResponse, type GuestNoteThreadDto, type GuestSessionResponse, type GuestVideoDto,
  type RichTextDoc,
} from "@quincy/shared";
import { uploadImageVia, uploadVideoVia, type EditorMediaTransport, type MediaIo } from "../lib/embedded-media-core";

/**
 * The guest page's own fetch wrapper (#741 12b). It is not `lib/api`: it carries no staff session, base URL or error type, only relative `/d/api/links/<linkId>/...` paths with
 * `credentials: "same-origin"`. Every response is parsed with the strict shared schema. The server answers every no-access outcome with the same stub, so a read that is a 4xx
 * (404, a lost 401 session) is `gone` and the page never tries to say why. A network failure, a 5xx or a 429 is `transient`: it says nothing about the link, so the page offers a retry.
 */
export type Read<T> = { kind: "ok"; value: T } | { kind: "gone" } | { kind: "transient" };

/** The Download all manifest read: a 401 is `verify` (the guest has to confirm an email first; the link is fine), never `gone`. A 403 `download_disabled` is `disabled` (staff turned downloads off while the page was open; the review itself is fine). Only a 404 or the stub is `gone`. */
export type DownloadsRead = Read<GuestDownloadManifest> | { kind: "verify" } | { kind: "disabled" };

/** `POST .../downloads/prepare` (#802): the archive's state after the server queued what it needs. `rejected` is the request's own refusal (nothing to download, over the cap); `limited` and the network are `transient`. */
export type DownloadsPrepare = Read<GuestArchivePrepareResponse> | { kind: "verify" } | { kind: "disabled" } | { kind: "rejected" };

export type ExchangeResult =
  | { ok: true; session: GuestSessionResponse }
  | { ok: false; reason: "passcode_required" | "passcode_incorrect" | "invalid_input" | "unavailable" | "unreachable" }
  | { ok: false; reason: "limited"; retryAfterSeconds: number };

/** `POST .../email/code`. A well-formed address is always 202 (no oracle); `limited` carries the server's retry time. */
export type SendCodeResult =
  | { ok: true; resendAfterSeconds: number }
  | { ok: false; reason: "invalid" | "gone" | "archived" | "unreachable" | "already_verified" }
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
  | { kind: "ok"; thread: GuestNoteThreadDto | null; /** Only `setSubscription`: the server's own answer, which wins over what the switch asked for. */ subscribed?: boolean }
  | { kind: "conflict"; thread: GuestNoteThreadDto }
  | { kind: "deleted" }
  | { kind: "unverified" }
  | { kind: "gone" }
  | { kind: "archived" }
  | { kind: "limited"; retryAfterSeconds: number }
  | { kind: "rejected"; error: string }
  | { kind: "unreachable" };

/**
 * A guest note paste (#741 13d), preview or commit. `changed` is 409 `paste_stale`: a source note changed since the preview, nothing was written, and `preview` is the current plan. (Not `stale`: that is
 * the writer's word for an answer that arrived after the screen moved on.) The other refusals are the ones a note write has.
 */
export type PasteResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "changed"; preview: GuestNotePastePreviewResponse }
  | { kind: "unverified" }
  | { kind: "gone" }
  | { kind: "archived" }
  | { kind: "limited"; retryAfterSeconds: number }
  | { kind: "rejected"; error: string }
  | { kind: "unreachable" };

/**
 * A guest decision (#741 14-ui-guest): approve or ask for changes on one Version. `ok.decision` is the event just recorded. `conflict` is 409 `decision_conflict` (two decisions landed at once:
 * try again); `disabled` is 403 `approve_disabled` (staff turned approving off while the page was open); `unverified` is 401; `gone` is the stub; `archived` is 409 `project_archived`;
 * `rejected` is every other refusal of the request itself (400, 413).
 */
export type DecisionResult =
  | { kind: "ok"; decision: GuestDecision }
  | { kind: "conflict" }
  | { kind: "disabled" }
  | { kind: "unverified" }
  | { kind: "gone" }
  | { kind: "archived" }
  | { kind: "limited"; retryAfterSeconds: number }
  | { kind: "rejected"; error: string }
  | { kind: "unreachable" };

/** In words for the guest: why a media upload was refused. The status rides on the error so the upload flow can tell a refusal from a blip. */
async function mediaRefusal(response: Response): Promise<Error> {
  let code = "";
  try { const body = await response.json() as { error?: unknown }; if (typeof body.error === "string") code = body.error; } catch { /* a body that does not read says nothing more */ }
  const message = response.status === 401 ? "Verify your email again to keep going."
    : response.status === 403 && code === "comments_disabled" ? "Comments are turned off on this link."
    : response.status === 409 && code === "project_archived" ? "This project was archived, so notes are read-only."
    : response.status === 429 ? "You're uploading too quickly. Try again in a few minutes."
    : response.status === 404 ? "This link isn't available."
    : response.status >= 500 ? "Quincy couldn't be reached. Try again."
    : "That file can't be uploaded.";
  return Object.assign(new Error(message), { status: response.status });
}

/**
 * The guest's media routes (`/d/api/links/:linkId/media`, #835 C) as the shared upload flows run them, and the editor transport built on them: images and videos, never HEIC (a guest has no
 * settings route to ask, and the server refuses it unless the owner turned it on). Same-origin cookies only, like every other call here.
 */
export function createGuestMediaTransport(linkId: string): EditorMediaTransport {
  const base = `/d/api/links/${linkId}/media`;
  const at = (mediaId: string) => `${base}/${encodeURIComponent(mediaId)}`;
  const post = async (url: string, body: unknown): Promise<unknown> => {
    const response = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw await mediaRefusal(response);
    return response.json();
  };
  const io: MediaIo = {
    presign: (body) => post(base, body),
    directUrl: (mediaId) => `${at(mediaId)}/direct`,
    complete: (mediaId, body) => post(`${at(mediaId)}/complete`, body),
    rendition: async (mediaId, signal) => {
      const response = await fetch(`${at(mediaId)}/rendition`, { credentials: "same-origin", ...(signal ? { signal } : {}) });
      if (!response.ok) throw await mediaRefusal(response);
      return response.json();
    },
    abort: (mediaId) => fetch(`${at(mediaId)}/abort`, { method: "POST", credentials: "same-origin", keepalive: true, headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined),
    putPoster: (mediaId, frame, signal) => fetch(`${at(mediaId)}/poster`, { method: "PUT", credentials: "same-origin", headers: { "content-type": "image/jpeg" }, body: frame, ...(signal ? { signal } : {}) }).then((response) => response.ok, () => false),
  };
  return {
    heicEnabled: false,
    video: true,
    mediaUrl: at,
    posterUrl: (mediaId) => `${at(mediaId)}/poster`,
    uploadImage: (file, onProgress, options) => uploadImageVia(io, file, onProgress, options),
    uploadVideo: (file, options) => uploadVideoVia(io, file, options),
    abort: (mediaId) => io.abort(mediaId),
  };
}

export type GuestApi = {
  /** The link's media (#835 C): where a note's pictures are read from, and what the editor uploads through. One per page, so its identity is stable. */
  media: EditorMediaTransport;
  /** The Download all route (#741 14b). The page only ever links to it: a download is the browser's, so the page cannot read its status. */
  downloadAllUrl: string;
  decide(assetId: string, decision: GuestDecisionInput["decision"], note?: string): Promise<DecisionResult>;
  downloads(): Promise<DownloadsRead>;
  /** Asks the server to prepare Download all (queues the CRC-32 job for what is missing). The manifest only reports; this is what starts the work. */
  prepareDownloads(): Promise<DownloadsPrepare>;
  exchange(token: string, passcode?: string): Promise<ExchangeResult>;
  session(): Promise<Read<GuestSessionResponse>>;
  videos(): Promise<Read<GuestVideoDto[]>>;
  notes(assetId: string): Promise<Read<GuestNoteThreadDto[]>>;
  markup(noteId: string): Promise<Read<GuestNoteMarkupResponse>>;
  sendCode(email: string): Promise<SendCodeResult>;
  verifyCode(code: string, name: string): Promise<VerifyResult>;
  createNote(assetId: string, input: GuestNoteCreateInput): Promise<WriteResult>;
  replyToNote(noteId: string, content: RichTextDoc): Promise<WriteResult>;
  editNote(noteId: string, input: GuestNoteEditInput): Promise<WriteResult>;
  deleteNote(noteId: string, expectedRevision: number): Promise<WriteResult>;
  /** `PUT .../subscription` (#741 15b): the verified guest's own email-updates switch. `ok.thread` is always null; `ok.subscribed` is the server's answer. */
  setSubscription(subscribed: boolean): Promise<WriteResult>;
  previewPaste(targetAssetId: string, input: GuestNotePastePreviewInput): Promise<PasteResult<GuestNotePastePreviewResponse>>;
  commitPaste(targetAssetId: string, input: GuestNotePasteCommitInput): Promise<PasteResult<GuestNotePasteCommitResponse>>;
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
    return readResponse(response, parse);
  };
  const readResponse = async <T>(response: Response | null, parse: (body: unknown) => T): Promise<Read<T>> => {
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
  const write = async (path: string, method: string, body: unknown, parseOk: (body: unknown) => GuestNoteThreadDto | null, parseExtra?: (body: unknown) => { subscribed: boolean }): Promise<WriteResult> => {
    const response = await send(path, { method, headers: JSON_HEADERS, body: JSON.stringify(body) });
    if (response === null) return { kind: "unreachable" };
    const read = await readJson(response);
    const parsedBody = read === null ? undefined : read.body;
    if (response.ok) {
      if (read === null) return { kind: "unreachable" };
      try { return { kind: "ok", thread: parseOk(read.body), ...parseExtra?.(read.body) }; } catch { return { kind: "unreachable" }; }
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
  /** A paste call: the same reading of a refusal as `write`, with 409 `paste_stale` carrying the fresh plan. */
  const paste = async <T,>(path: string, body: unknown, parseOk: (body: unknown) => T): Promise<PasteResult<T>> => {
    const response = await send(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    if (response === null) return { kind: "unreachable" };
    const read = await readJson(response);
    if (response.ok) {
      if (read === null) return { kind: "unreachable" };
      try { return { kind: "ok", value: parseOk(read.body) }; } catch { return { kind: "unreachable" }; }
    }
    const parsedBody = read === null ? undefined : read.body;
    if (response.status >= 500) return { kind: "unreachable" };
    if (response.status === 429) return { kind: "limited", retryAfterSeconds: retryAfter(response, parsedBody) };
    if (response.status === 401) return { kind: "unverified" };
    if (response.status === 404 || response.status === 403) return { kind: "gone" };
    if (response.status === 409) {
      if (errorOf(parsedBody) === "project_archived") return { kind: "archived" };
      const stale = guestNotePasteStaleSchema.safeParse(parsedBody);
      if (stale.success) return { kind: "changed", preview: stale.data.preview };
    }
    return { kind: "rejected", error: errorOf(parsedBody) };
  };
  return {
    media: createGuestMediaTransport(linkId),
    downloadAllUrl: `${base}/downloads/all.zip`,
    async decide(assetId, decision, note) {
      const response = await send(`/versions/${assetId}/decision`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(note === undefined ? { decision } : { decision, note }) });
      if (response === null) return { kind: "unreachable" };
      const read = await readJson(response);
      const error = errorOf(read?.body);
      if (response.ok) {
        const parsed = read === null ? null : guestDecisionResponseSchema.safeParse(read.body);
        return parsed?.success ? { kind: "ok", decision: parsed.data.decision } : { kind: "unreachable" };
      }
      if (response.status >= 500) return { kind: "unreachable" };
      if (response.status === 429) return { kind: "limited", retryAfterSeconds: retryAfter(response, read?.body) };
      if (response.status === 401) return { kind: "unverified" };
      if (response.status === 403 && error === "approve_disabled") return { kind: "disabled" };
      if (response.status === 404 || response.status === 403) return { kind: "gone" };
      if (response.status === 409) {
        if (error === "project_archived") return { kind: "archived" };
        if (error === "decision_conflict") return { kind: "conflict" };
      }
      return { kind: "rejected", error };
    },
    async downloads() {
      const response = await send("/downloads");
      if (response?.status === 401) return { kind: "verify" };
      if (response?.status === 403 && errorOf((await readJson(response.clone()))?.body) === "download_disabled") return { kind: "disabled" };
      return readResponse(response, (body) => guestDownloadManifestSchema.parse(body));
    },
    async prepareDownloads() {
      const response = await send("/downloads/prepare", { method: "POST", headers: JSON_HEADERS, body: "{}" });
      if (response?.status === 401) return { kind: "verify" };
      if (response?.status === 403 && errorOf((await readJson(response.clone()))?.body) === "download_disabled") return { kind: "disabled" };
      if (response?.status === 409 || response?.status === 422) return { kind: "rejected" };
      return readResponse(response, (body) => guestArchivePrepareResponseSchema.parse(body));
    },
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
      if (response.status === 409 && errorOf(read?.body) === "already_verified") return { ok: false, reason: "already_verified" };
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
    replyToNote: (noteId, content) => write(`/notes/${noteId}/replies`, "POST", { content }, (parsed) => guestNoteWriteResponseSchema.parse(parsed)),
    editNote: (noteId, input) => write(`/notes/${noteId}`, "PATCH", input, (body) => guestNoteWriteResponseSchema.parse(body)),
    deleteNote: (noteId, expectedRevision) => write(`/notes/${noteId}`, "DELETE", { expectedRevision }, (body) => guestNoteDeleteResponseSchema.parse(body).thread),
    setSubscription: (subscribed) => write("/subscription", "PUT", { subscribed }, () => null, (body) => ({ subscribed: guestSubscriptionResponseSchema.parse(body).subscribed })),
    previewPaste: (targetAssetId, input) => paste(`/versions/${targetAssetId}/note-paste/preview`, input, (body) => guestNotePastePreviewResponseSchema.parse(body)),
    commitPaste: (targetAssetId, input) => paste(`/versions/${targetAssetId}/note-paste`, input, (body) => guestNotePasteCommitResponseSchema.parse(body)),
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

/**
 * `POST /d/api/unsubscribe` (#741 15b): the digest email's tokened link. No session, no link id; the token travels in the body only. `subscribed` omitted unsubscribes, true resubscribes.
 * `ok.subscribed` is the state the server reports. Any non-2xx answer or a body that reads but fails the schema is `gone` (the stub covers unknown tokens); a network failure, an unreadable body, a 5xx or a 429 is `transient`.
 */
export type UnsubscribeResult = { kind: "ok"; subscribed: boolean } | { kind: "gone" } | { kind: "transient" };
export async function postUnsubscribe(token: string, subscribed?: boolean): Promise<UnsubscribeResult> {
  let response: Response;
  try {
    response = await fetch("/d/api/unsubscribe", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(subscribed === undefined ? { token } : { token, subscribed }) });
  } catch { return { kind: "transient" }; }
  if (response.status >= 500 || response.status === 429) return { kind: "transient" };
  if (!response.ok) return { kind: "gone" };
  // A body that cannot be read (the connection dropped after the headers) is transient: the token is scrubbed, so only Retry can recover. A body that reads but fails the schema is `gone`.
  let body: unknown;
  try { body = await response.json(); } catch { return { kind: "transient" }; }
  const parsed = guestSubscriptionResponseSchema.safeParse(body);
  return parsed.success ? { kind: "ok", subscribed: parsed.data.subscribed } : { kind: "gone" };
}
