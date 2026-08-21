import wreq from "wreq-js";
import type { ProxyConfig } from "../../domain/proxy.js";
import { proxyUrl } from "../../domain/proxy.js";
import type { LbcTransport, TransportRequest, TransportResponse } from "./transport.js";

export const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Transport wreq-js 3.x — cœur Rust, impersonation TLS/HTTP2 Chrome 131 Windows.
 * Profil cohérent partout : UA + fingerprint + proxy identiques entre recherche,
 * challenge et rejeu (le cookie datadome est lié à l'IP et à l'UA).
 */
export class WreqTransport implements LbcTransport {
  readonly kind = "wreq" as const;
  private readonly proxy?: string;
  private readonly userAgent: string;
  /** Cookies injectés à chaque requête (session importée + datadome résolu). */
  cookies: Record<string, string> = {};

  constructor(opts: { proxy?: ProxyConfig; userAgent?: string; cookies?: Record<string, string> } = {}) {
    this.proxy = opts.proxy ? proxyUrl(opts.proxy) : undefined;
    this.userAgent = opts.userAgent ?? CHROME_UA;
    this.cookies = { ...(opts.cookies ?? {}) };
  }

  async request(req: TransportRequest): Promise<TransportResponse> {
    const cookieHeader = Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    const res = await wreq.fetch(req.url, {
      method: (req.method ?? "GET") as "GET" | "POST",
      browser: "chrome_131",
      os: "windows",
      ...(this.proxy ? { proxy: this.proxy } : {}),
      timeout: req.timeoutMs ?? 20_000,
      headers: {
        "User-Agent": this.userAgent,
        "Accept-Language": "fr-FR,fr;q=0.9",
        ...(req.body ? { "Content-Type": "application/json" } : {}),
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        ...(req.headers ?? {}),
      },
      ...(req.body ? { body: req.body } : {}),
    });
    const body = await res.text();
    const headers: Record<string, string> = {};
    res.headers?.forEach?.((v: string, k: string) => (headers[k] = v));
    // AUCUN auto-replay des cookies de réponse : le cookie datadome posé par le
    // bord est invalidé au rejeu (mesuré : jar partagé 4/8 en alternance 200/403,
    // sessions fraîches 8/8 direct et proxy). Seuls les cookies explicites
    // (session importée, challenge résolu) partent en Cookie:.
    return { status: res.status, headers, body };
  }
}
