export type Json = Record<string, unknown>;

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  dispatcher?: unknown;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly responseBody: string
  ) {
    super(`HTTP ${status} sur ${url}`);
    this.name = "HttpError";
  }
}

/**
 * fetch JSON avec timeout — injectable (fetchImpl) pour les tests.
 * dispatcher permet de passer un ProxyAgent undici.
 */
export async function requestJson<T = Json>(
  url: string,
  opts: RequestOptions = {},
  fetchImpl: typeof fetch = fetch
): Promise<{ status: number; json: T | null; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetchImpl(url, {
      method: opts.method ?? "GET",
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
      ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
    } as RequestInit);
    const text = await res.text();
    let json: T | null = null;
    try {
      json = text ? (JSON.parse(text) as T) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

export async function expectOk<T = Json>(
  url: string,
  opts: RequestOptions = {},
  fetchImpl: typeof fetch = fetch
): Promise<T> {
  const res = await requestJson<T>(url, opts, fetchImpl);
  if (res.status < 200 || res.status >= 300) {
    throw new HttpError(res.status, url, res.text);
  }
  return res.json as T;
}
