export type MultipartPresign = {
  key: string;
  uploadId?: string;
  partUrls?: string[];
  partBytes?: number;
  devDirect?: boolean;
};

export type CompletedMultipart = { uploadId?: string; parts?: { partNumber: number; etag: string }[] };

/** Exported to test exact boundaries with tiny parts; production passes the R2 reservation size. */
export function multipartSlices(bytes: number, partBytes: number) {
  if (!Number.isInteger(bytes) || bytes <= 0 || !Number.isInteger(partBytes) || partBytes <= 0) throw new Error("Multipart bytes and part size must be positive integers.");
  return Array.from({ length: Math.ceil(bytes / partBytes) }, (_, index) => ({ start: index * partBytes, end: Math.min(bytes, (index + 1) * partBytes) }));
}

/**
 * Byte-level progress and cancel (#494), opt-in: a caller that passes a control sends each part over XHR (fetch cannot report upload
 * bytes) and can stop it. A caller that passes none keeps the fetch path unchanged.
 */
export type UploadControl = {
  signal?: AbortSignal;
  onBytes?: (loaded: number, total: number) => void;
  /** Bounded per-part retry (#741), opt-in: a part that fails with status 0, 408, 429 or 5xx is sent again to the same URL, `attempts` more times. Never on 403. */
  retry?: { attempts: number; /** Waits before each retry; defaults to 1 s / 3 s / 9 s. */ delaysMs?: readonly number[] };
  /** Parts already stored (a manual retry resumes): they are skipped and their ETags returned as they were. */
  doneParts?: readonly { partNumber: number; etag: string }[];
  /** Called once per part as it is stored. */
  onPart?: (part: { partNumber: number; etag: string }) => void;
};

const abortError = () => Object.assign(new Error("Upload cancelled"), { name: "AbortError" });

/** A multipart part that could not be stored. `retryable` says whether sending the same part again can help (false for an expired link). */
export class PartUploadError extends Error {
  constructor(message: string, readonly partNumber: number, readonly status: number, readonly retryable: boolean) {
    super(message);
    this.name = "PartUploadError";
  }
}

export const PART_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 9_000];
const retryableStatus = (status: number) => status === 0 || status === 408 || status === 429 || status >= 500;

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** One PUT over XHR. Resolves with the response status and ETag; rejects as an AbortError when the signal fires. */
function putOverXhr(url: string, body: Blob, options: { headers?: Record<string, string>; credentials?: boolean; signal?: AbortSignal; onLoaded?: (loaded: number) => void }): Promise<{ status: number; etag: string | null }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(abortError()); return; }
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    const done = () => options.signal?.removeEventListener("abort", onAbort);
    xhr.open("PUT", url);
    if (options.credentials) xhr.withCredentials = true;
    for (const [name, value] of Object.entries(options.headers ?? {})) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) options.onLoaded?.(event.loaded); };
    xhr.onload = () => { done(); resolve({ status: xhr.status, etag: xhr.getResponseHeader("etag") }); };
    xhr.onerror = () => { done(); resolve({ status: 0, etag: null }); };
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = () => { done(); reject(abortError()); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    xhr.send(body);
  });
}

/** Upload bytes directly to R2. The API only receives the small completion payload. */
export async function uploadMultipartFile(file: File, presign: MultipartPresign, devDirectUrl: string, onProgress?: (percent: number) => void, control?: UploadControl): Promise<CompletedMultipart> {
  if (control) return uploadWithControl(file, presign, devDirectUrl, onProgress, control);
  if (presign.devDirect) {
    const response = await fetch(devDirectUrl, { method: "PUT", credentials: "include", headers: { "content-type": file.type }, body: file });
    if (!response.ok) throw new Error("Direct upload failed.");
    onProgress?.(100);
    return {};
  }
  if (!presign.partUrls?.length || !presign.uploadId || !presign.partBytes) throw new Error("Upload service returned an incomplete multipart session.");
  const parts: { partNumber: number; etag: string }[] = [];
  const slices = multipartSlices(file.size, presign.partBytes);
  if (slices.length !== presign.partUrls.length) throw new Error("Upload service returned an invalid multipart part count.");
  for (let index = 0; index < slices.length; index += 1) {
    const slice = slices[index]!;
    const response = await fetch(presign.partUrls[index]!, { method: "PUT", body: file.slice(slice.start, slice.end) });
    if (!response.ok) throw new Error(`Part ${index + 1} could not be uploaded.`);
    const etag = response.headers.get("etag");
    if (!etag) throw new Error(`Part ${index + 1} returned no ETag.`);
    parts.push({ partNumber: index + 1, etag });
    onProgress?.(Math.round(((index + 1) / presign.partUrls.length) * 100));
  }
  return { uploadId: presign.uploadId, parts };
}

async function uploadWithControl(file: File, presign: MultipartPresign, devDirectUrl: string, onProgress: ((percent: number) => void) | undefined, control: UploadControl): Promise<CompletedMultipart> {
  const total = file.size;
  const report = (loaded: number) => { control.onBytes?.(loaded, total); onProgress?.(Math.min(100, Math.round((loaded / total) * 100))); };
  if (presign.devDirect) {
    const response = await putOverXhr(devDirectUrl, file, { headers: { "content-type": file.type }, credentials: true, signal: control.signal, onLoaded: report });
    if (response.status < 200 || response.status >= 300) throw new Error("Direct upload failed.");
    report(total);
    return {};
  }
  if (!presign.partUrls?.length || !presign.uploadId || !presign.partBytes) throw new Error("Upload service returned an incomplete multipart session.");
  const parts: { partNumber: number; etag: string }[] = [];
  const slices = multipartSlices(file.size, presign.partBytes);
  if (slices.length !== presign.partUrls.length) throw new Error("Upload service returned an invalid multipart part count.");
  let finished = 0;
  const done = new Map((control.doneParts ?? []).map((part) => [part.partNumber, part]));
  for (let index = 0; index < slices.length; index += 1) {
    const slice = slices[index]!;
    const stored = done.get(index + 1);
    if (stored) { parts.push(stored); finished += slice.end - slice.start; report(finished); continue; }
    if (control.signal?.aborted) throw abortError();
    const attempts = control.retry?.attempts ?? 0;
    const delays = control.retry?.delaysMs ?? PART_RETRY_DELAYS_MS;
    let response: { status: number; etag: string | null };
    for (let attempt = 0; ; attempt += 1) {
      response = await putOverXhr(presign.partUrls[index]!, file.slice(slice.start, slice.end), { signal: control.signal, onLoaded: (loaded) => report(finished + loaded) });
      if (response.status >= 200 && response.status < 300) break;
      report(finished);
      if (control.retry && response.status === 403) throw new PartUploadError("This upload took too long and its upload link expired. Start it again.", index + 1, 403, false);
      if (!control.retry || !retryableStatus(response.status) || attempt >= attempts) throw new PartUploadError(`Part ${index + 1} could not be uploaded.`, index + 1, response.status, Boolean(control.retry) && retryableStatus(response.status));
      await sleepUnlessAborted(delays[Math.min(attempt, delays.length - 1)] ?? 0, control.signal);
    }
    if (!response.etag) throw new Error(`Part ${index + 1} returned no ETag.`);
    const part = { partNumber: index + 1, etag: response.etag };
    parts.push(part);
    control.onPart?.(part);
    finished += slice.end - slice.start;
    report(finished);
  }
  return { uploadId: presign.uploadId, parts };
}
