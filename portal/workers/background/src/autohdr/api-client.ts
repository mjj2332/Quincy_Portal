export const AUTOHDR_API_BASE_URL = "https://quantumreachadvertising.com/external-api/v2";

export type AutoHdrPresignedFile = { filename: string };
export type AutoHdrPresignedPhotoshoot = { uid: string; uploadedFiles: string[] };

function apiHeaders(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function responseDetail(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 600);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["error", "message", "detail"]) {
      if (typeof record[key] === "string") return record[key].slice(0, 600);
    }
    try { return JSON.stringify(value).slice(0, 600); } catch { /* fall through */ }
  }
  return "No response details were provided";
}

async function responsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

async function requireOk(response: Response, operation: string): Promise<unknown> {
  const payload = await responsePayload(response);
  if (!response.ok) {
    throw new Error(`AutoHDR ${operation} failed (${response.status}): ${responseDetail(payload)}`);
  }
  return payload;
}

export async function createAutoHdrPresignedPhotoshoot(
  apiKey: string,
  input: { files: AutoHdrPresignedFile[]; address?: string },
): Promise<AutoHdrPresignedPhotoshoot> {
  const response = await fetch(`${AUTOHDR_API_BASE_URL}/create-photoshoot-with-presigned-urls`, {
    method: "POST",
    headers: apiHeaders(apiKey),
    body: JSON.stringify({
      files: input.files,
      ...(input.address ? { address: input.address } : {}),
    }),
  });
  const payload = await requireOk(response, "photoshoot creation");
  if (!payload || typeof payload !== "object") throw new Error("AutoHDR photoshoot creation returned an invalid response");
  const record = payload as Record<string, unknown>;
  const uid = typeof record.uid === "string" ? record.uid.trim() : "";
  const uploadedFiles = Array.isArray(record.uploaded_files)
    ? record.uploaded_files.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  if (!uid || uploadedFiles.length !== input.files.length) {
    throw new Error("AutoHDR photoshoot creation did not return one upload URL per selected photo");
  }
  return { uid, uploadedFiles };
}

export async function uploadAutoHdrPresignedFile(
  uploadUrl: string,
  body: BodyInit,
  contentType = "image/jpeg",
): Promise<void> {
  let target: URL;
  try { target = new URL(uploadUrl); } catch { throw new Error("AutoHDR returned an invalid upload URL"); }
  if (target.protocol !== "https:") throw new Error("AutoHDR returned a non-HTTPS upload URL");
  const response = await fetch(target.toString(), {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body,
  });
  await requireOk(response, "photo upload");
}

export async function finalizeAutoHdrPhotoshoot(apiKey: string, uid: string): Promise<void> {
  const response = await fetch(`${AUTOHDR_API_BASE_URL}/finalize-photoshoot-upload`, {
    method: "POST",
    headers: apiHeaders(apiKey),
    body: JSON.stringify({ uid }),
  });
  await requireOk(response, "photoshoot finalization");
}
