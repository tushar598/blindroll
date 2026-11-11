/** Small fetch wrapper for our own API: JSON in, JSON out, errors as ApiError with the server's message. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api<T>(path: string, init?: { method?: string; json?: unknown; form?: FormData }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.json !== undefined || init?.form ? "POST" : "GET"),
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.form ?? (init?.json !== undefined ? JSON.stringify(init.json) : undefined),
    credentials: "same-origin",
    cache: "no-store",
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? "http_error", e?.message ?? `Request failed (HTTP ${res.status})`);
  }
  return body as T;
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong");
