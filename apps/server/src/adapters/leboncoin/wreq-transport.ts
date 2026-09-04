import wreq from "wreq-js";
import type { ProxyConfig } from "../../domain/proxy.js";
import { proxyUrl } from "../../domain/proxy.js";
import type { LbcTransport, TransportRequest, TransportResponse } from "./transport.js";
import { pickFingerprint, userAgentFor, type Fingerprint } from "./fingerprint.js";
import { paced } from "./pacer.js";

/**
 * UA de repli, utilisé uniquement là où un appelant impose explicitement son
 * propre User-Agent (rejeu de contrat messagerie capturé). La recherche ne
 * s'en sert jamais : son UA vient du profil TLS tiré au sort.
 * @deprecated pour la recherche — voir `userAgentFor(fingerprint)`.
 */
export const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Transport wreq-js 3.x — cœur Rust, impersonation TLS/HTTP2.
 *
 * Deux règles tirées de la mesure du 04/09/2026 (cf. `fingerprint.ts`) :
 *  1. l'empreinte est tirée au sort à la construction et re-tirable via
 *     `rotate()` — plus jamais de profil figé (`chrome_131` = 403 systématique) ;
 *  2. l'UA n'est jamais une constante : il est dérivé du profil actif, pour que
 *     UA, `sec-ch-ua` et JA4 racontent tous la même histoire.
 *
 * Toutes les requêtes traversent le cadenceur global (`paced`) : c'est lui, et
 * pas l'appelant, qui garantit l'espacement entre deux appels leboncoin.fr.
 */
export class WreqTransport implements LbcTransport {
  readonly kind = "wreq" as const;
  private readonly proxy?: string;
  /** UA imposé par l'appelant (rejeu messagerie). Absent = UA du profil. */
  private readonly pinnedUserAgent?: string;
  private readonly bypassPacer: boolean;
  private fingerprint: Fingerprint;
  /** Cookies injectés à chaque requête (session importée + datadome résolu). */
  cookies: Record<string, string> = {};

  constructor(
    opts: {
      proxy?: ProxyConfig;
      /** À ne passer que pour rejouer un contrat capturé avec SON UA. */
      userAgent?: string;
      cookies?: Record<string, string>;
      fingerprint?: Fingerprint;
      /**
       * Sort du cadenceur global. Réservé aux diagnostics volontairement
       * agressifs (stress test) : une veille ne doit JAMAIS passer ce drapeau.
       */
      bypassPacer?: boolean;
    } = {}
  ) {
    this.bypassPacer = opts.bypassPacer ?? false;
    this.proxy = opts.proxy ? proxyUrl(opts.proxy) : undefined;
    this.pinnedUserAgent = opts.userAgent;
    this.fingerprint = opts.fingerprint ?? pickFingerprint();
    this.cookies = { ...(opts.cookies ?? {}) };
  }

  /** Profil TLS actif — pour les logs, les diagnostics et AnySolver. */
  get profile(): Fingerprint {
    return this.fingerprint;
  }

  /** UA réellement envoyé (celui du profil, sauf UA imposé). */
  get userAgent(): string {
    return this.pinnedUserAgent ?? userAgentFor(this.fingerprint);
  }

  /**
   * Change d'empreinte en excluant celles déjà brûlées sur ce job. Les cookies
   * datadome liés à l'ancienne signature sont jetés : les rejouer sur un autre
   * profil est un signal de plus, pas un atout.
   */
  rotate(exclude: readonly Fingerprint[] = []): Fingerprint {
    this.fingerprint = pickFingerprint([this.fingerprint, ...exclude]);
    delete this.cookies["datadome"];
    return this.fingerprint;
  }

  async request(req: TransportRequest): Promise<TransportResponse> {
    const cookieHeader = Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    const send = async (): Promise<TransportResponse> => {
      const res = await wreq.fetch(req.url, {
        method: (req.method ?? "GET") as "GET" | "POST",
        browser: this.fingerprint.browser as never,
        os: this.fingerprint.os as never,
        ...(this.proxy ? { proxy: this.proxy } : {}),
        timeout: req.timeoutMs ?? 20_000,
        headers: {
          // UA/sec-ch-ua/accept/ordre : fournis par l'émulation du profil.
          // On ne surcharge que ce qui est propre à un visiteur français.
          ...(this.pinnedUserAgent ? { "User-Agent": this.pinnedUserAgent } : {}),
          "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
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
    };
    return this.bypassPacer ? send() : paced(req.url, send);
  }
}
