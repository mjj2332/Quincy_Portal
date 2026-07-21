export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function messageFromPayload(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;

  const value = payload as Record<string, unknown>;
  if (typeof value.message === "string") return value.message;
  if (typeof value.error === "string") return value.error;
  if (value.error && typeof value.error === "object") {
    const nested = value.error as Record<string, unknown>;
    if (typeof nested.message === "string") return nested.message;
  }

  return fallback;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, {
      ...init,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...init.headers,
      },
    });
  } catch (error) {
    // Abort is control flow for view changes, not an API failure. Callers that use an
    // AbortController need to distinguish it from a real transport error.
    if (error instanceof Error && error.name === "AbortError") throw error;
    const message = error instanceof Error ? error.message : "The network request failed.";
    throw new ApiError(message, 0, error);
  }

  const isJson = response.headers.get("content-type")?.includes("application/json") ?? false;
  const payload: unknown = isJson ? await response.json().catch(() => undefined) : await response.text();

  if (!response.ok) {
    throw new ApiError(
      messageFromPayload(payload, `Request failed (${response.status}).`),
      response.status,
      payload,
    );
  }

  return payload as T;
}

export function apiGet<T>(path: string, init?: Pick<RequestInit, "signal">): Promise<T> {
  return request<T>(path, init);
}

export function apiPost<T, TBody>(path: string, body: TBody): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

export function apiPostForm<T>(path: string, body: FormData): Promise<T> {
  return request<T>(path, { method: "POST", body });
}

export function apiPatch<T, TBody>(path: string, body: TBody): Promise<T> {
  return request<T>(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
