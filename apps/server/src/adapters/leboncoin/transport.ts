import { ProxyAgent } from "undici";
import type { ProxyConfig } from "../../domain/proxy.js";
import { proxyUrl } from "../../domain/proxy.js";

export interface TransportRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface LbcSessionProfile {
  userAgent: string;
  cookies: Record<string, string>;
}

/**
 * Transport HTTP pour Leboncoin. Deux implémentations :
 *  - FetchTransport : fetch + ProxyAgent undici (dev, diagnostics, phase courante)
 *  - WreqTransport   : wreq-js 3.x, cœur Rust, impersonation Chrome Windows (phase 5)
 * Les deux exposent le même contrat ; l'engine n'en connaît que l'interface.
 */
export interface LbcTransport {
  readonly kind: "fetch" | "wreq";
  request(req: TransportRequest): Promise<TransportResponse>;
}

export class FetchTransport implements LbcTransport {
  readonly kind = "fetch" as const;
  private readonly dispatcher: ProxyAgent | null;
  private readonly userAgent: string;

  constructor(opts: { proxy?: ProxyConfig; userAgent?: string } = {}) {
    this.userAgent =
      opts.userAgent ??
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    this.dispatcher = opts.proxy ? new ProxyAgent(proxyUrl(opts.proxy)) : null;
  }

  async request(req: TransportRequest): Promise<TransportResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 20_000);
    try {
      const res = await fetch(req.url, {
        method: req.method ?? "GET",
        headers: {
          "User-Agent": this.userAgent,
          "Accept-Language": "fr-FR,fr;q=0.9",
          ...(req.body ? { "Content-Type": "application/json" } : {}),
          ...req.headers,
        },
        body: req.body,
        signal: controller.signal,
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      } as RequestInit);
      const body = await res.text();
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      return { status: res.status, headers, body };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}
