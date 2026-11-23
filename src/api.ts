export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** JSON call to the local API (Vite proxies /api → the Node server). */
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, msg);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export interface Stats {
  range: { days: number; start: string; end: string; tz: string };
  totals: { plays: number; chars: number; texts: number };
  top: { id: string; text: string; plays: number; chars: number; lastPlayed: number }[];
  daily: { day: string; plays: number }[];
}
