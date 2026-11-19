export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}

/** POST JSON (or FormData) and normalise errors into a message the UI can show. */
export async function post<T = unknown>(url: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const res = await fetch(url, {
      method: "POST",
      headers: body === undefined || isForm ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const issues = Array.isArray(json?.issues) ? json.issues.map((i: { message: string }) => i.message).join(". ") : "";
      return { ok: false, status: res.status, data: null, error: issues || json?.error || "Something went wrong" };
    }
    return { ok: true, status: res.status, data: json as T, error: null };
  } catch {
    return { ok: false, status: 0, data: null, error: "Cannot reach the server. Check your connection and try again." };
  }
}
