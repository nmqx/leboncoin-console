import type {
  Conversation,
  Delivery,
  Listing,
  Message,
  PricePoint,
  SearchJob,
  SseEvent,
  Status,
  Watch,
  Webhook,
} from "@lbc/contracts";

const BASE = "/api/v1";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly correlationId: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body as { error?: { code: string; message: string; retryable: boolean; correlationId: string } })?.error;
    throw new ApiError(
      err?.code ?? "network_error",
      err?.message ?? `HTTP ${res.status}`,
      err?.retryable ?? false,
      err?.correlationId ?? "-",
      res.status
    );
  }
  return body as T;
}

export interface ListingFilters {
  query?: string;
  priceMin?: number;
  priceMax?: number;
  ownerType?: "private" | "pro";
  shippable?: boolean;
  department?: string;
  category?: string;
  sort?: "price" | "publishedAt" | "relevance" | "distance";
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export const api = {
  status: () => call<Status>("/status"),
  diagnostics: () =>
    call<{
      mode: string;
      proxyConfigured: boolean;
      anysolverConfigured: boolean;
      llmConfigured: boolean;
      vault: string;
      lastSticky: unknown;
    }>("/diagnostics"),

  listings: (f: ListingFilters) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) {
      if (v !== undefined && v !== "" && v !== null) q.set(k, String(v));
    }
    return call<{ items: Listing[]; total: number }>(`/listings?${q.toString()}`);
  },
  listing: (id: string) => call<{ listing: Listing; priceHistory: PricePoint[] }>(`/listings/${id}`),

  searchJob: (spec: unknown) => call<SearchJob>("/search-jobs", { method: "POST", body: JSON.stringify(spec) }),

  watches: () => call<{ watches: Watch[] }>("/watches"),

  categories: () =>
    call<{
      categories: Array<{ id: string; name: string }>;
      rangeAttributes: Array<{ key: string; label: string }>;
    }>("/categories"),
  createWatch: (name: string, spec: unknown, cadenceMinutes = 10) =>
    call<Watch>("/watches", { method: "POST", body: JSON.stringify({ name, spec, cadenceMinutes }) }),
  updateWatch: (id: number, patch: Partial<Pick<Watch, "name" | "enabled" | "cadenceMinutes">> & { spec?: unknown }) =>
    call<Watch>(`/watches/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteWatch: (id: number) => call<{ ok: boolean }>(`/watches/${id}`, { method: "DELETE" }),
  runWatch: (id: number) => call<SearchJob>(`/watches/${id}/run`, { method: "POST" }),

  conversations: () => call<{ conversations: Conversation[] }>("/conversations"),
  conversation: (id: string) =>
    call<{ conversation: Conversation; messages: Message[]; listing: Listing | null }>(`/conversations/${id}`),
  reply: (id: string, body: string, opts: { auto?: boolean; dedupeKey?: string } = {}) =>
    call<{ inserted: boolean; message: Message }>(`/conversations/${id}/reply`, {
      method: "POST",
      body: JSON.stringify({ body, ...opts }),
    }),
  previewReply: (id: string) =>
    call<{ draft: { reply: string; classification: string | null; confidence: number } }>(`/conversations/${id}/preview-reply`, {
      method: "POST",
    }),

  automation: {
    enable: () => call<{ ok: boolean }>("/automation/enable", { method: "POST" }),
    disable: () => call<{ ok: boolean }>("/automation/disable", { method: "POST" }),
  },
  killSwitch: (enabled: boolean) =>
    call<{ ok: boolean; killSwitch: boolean }>("/system/kill-switch", { method: "POST", body: JSON.stringify({ enabled }) }),

  webhooks: () => call<{ webhooks: Webhook[] }>("/webhooks"),
  createWebhook: (kind: "discord" | "http", url: string, events: string[], secret?: string) =>
    call<Webhook>("/webhooks", { method: "POST", body: JSON.stringify({ kind, url, events, ...(secret ? { secret } : {}) }) }),
  updateWebhook: (id: number, patch: { enabled?: boolean; events?: string[] }) =>
    call<Webhook>(`/webhooks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteWebhook: (id: number) => call<{ ok: boolean }>(`/webhooks/${id}`, { method: "DELETE" }),
  testWebhook: (id: number) => call<{ ok: boolean; deliveries: Delivery[] }>(`/webhooks/${id}/test`, { method: "POST" }),
  deliveries: (id: number) => call<{ deliveries: Delivery[] }>(`/webhooks/${id}/deliveries`),
  replayDelivery: (id: number) => call<{ ok: boolean }>(`/webhooks/deliveries/${id}/replay`, { method: "POST" }),

  sessionImport: (payload: unknown) =>
    call<{ ok: boolean; userId: string | null; expiresAt: string | null; vault: string }>("/session/import", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  sessionStatus: () =>
    call<{ imported: boolean; userId: string | null; userAgent: string | null; expiresAt: string | null; expiresSoon: boolean }>(
      "/session/status"
    ),
  sessionDelete: () => call<{ ok: boolean }>("/session", { method: "DELETE" }),

  proxySticky: (proxy?: string, save = false) =>
    call<{
      sticky: boolean;
      ips: string[];
      probes: Array<{ ok: boolean; ip: string | null; status: number | null; latencyMs: number | null; error: string | null }>;
      direct: { ok: boolean; ip: string | null; latencyMs: number | null } | null;
    }>("/diagnostics/proxy-sticky", { method: "POST", body: JSON.stringify({ proxy, save }) }),
  anysolverCheck: (apiKey?: string) => call<{ ok: boolean; balance: number }>("/diagnostics/anysolver", { method: "POST", body: JSON.stringify(apiKey ? { apiKey } : {}) }),
  llmCheck: () => call<{ ok: boolean; model: string; latencyMs: number; sample: string }>("/diagnostics/llm", { method: "POST" }),
  llmKey: (apiKey: string) => call<{ ok: boolean }>("/system/llm-key", { method: "POST", body: JSON.stringify({ apiKey }) }),

  events: () => call<{ events: SseEvent[] }>("/events/recent"),
  audit: () =>
    call<{ entries: Array<{ id: number; action: string; detail: Record<string, unknown>; createdAt: string }> }>("/audit"),

  // ------------------------------------------------------------------ chrome
  chromeStart: () =>
    call<{
      ok: boolean; alreadyRunning?: boolean;
      status: { startedAt: string; port: number; capturedCount: number } | null;
      instructions?: string;
    }>("/session/chrome/start", { method: "POST" }),
  chromeStatus: () =>
    call<{
      running: boolean;
      status: { startedAt: string; port: number; capturedCount: number } | null;
      captured: Array<{ id: number; method: string; url: string; status: number | null; kind: string; capturedAt: string }>;
    }>("/session/chrome/status"),
  chromeFinish: () =>
    call<{ imported: boolean; userId: string | null; expiresAt: string | null; capturedCount: number }>(
      "/session/chrome/finish", { method: "POST" }
    ),
  capturedRequests: (kind?: string) =>
    call<{ captured: Array<{ id: number; method: string; url: string; status: number | null; kind: string; postData: string | null; capturedAt: string }> }>(
      `/captured-requests${kind ? `?kind=${kind}` : ""}`
    ),

  // ----------------------------------------------------------------- routage
  routing: () => call<{ search: "direct" | "proxy"; messaging: "direct" | "proxy" }>("/system/routing"),
  setRouting: (r: { search: "direct" | "proxy"; messaging: "direct" | "proxy" }) =>
    call<{ ok: boolean }>("/system/routing", { method: "PUT", body: JSON.stringify(r) }),

  // ------------------------------------------------------------------ stress
  stress: (count: number, useProxy: boolean) =>
    call<{
      leg: string; count: number; ok200: number; datadome: number; other: number;
      p50Ms: number | null; p95Ms: number | null;
      results: Array<{ status: number; latencyMs: number; datadome: boolean }>;
    }>("/diagnostics/stress", { method: "POST", body: JSON.stringify({ count, useProxy }) }),

  conversationsSync: () =>
    call<{ ok: boolean; synced: number; created: number }>("/conversations/sync", { method: "POST" }),
};
