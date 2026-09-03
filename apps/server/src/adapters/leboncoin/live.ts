import type { Listing, SearchSpec } from "@lbc/contracts";
import type { Bus } from "../../bus.js";
import type { Repos } from "../../repos.js";
import type { ProxyConfig } from "../../domain/proxy.js";
import { relevanceScore } from "../../domain/scoring.js";
import { isJunkListing } from "../../domain/junk.js";
import { WreqTransport } from "./wreq-transport.js";
import { classifyDataDome } from "./datadome.js";
import type { EngineRunResult, SearchEngine } from "./engine.js";
import { AnySolverClient, type DataDomeTaskType } from "../anysolver/client.js";
import { LlmClient, filterByRelevance } from "../llm/gemini.js";
import { jwtExpiry } from "../../session.js";
import { logger } from "../../logger.js";

// ---------------------------------------------------------------------------
// Normalisation du payload __NEXT_DATA__ (searchData.ads) vers le contrat Listing
// ---------------------------------------------------------------------------

interface RawAd {
  list_id: number | string;
  first_publication_date?: string;
  index_date?: string;
  status?: string;
  category_id?: string;
  category_name?: string;
  subject?: string;
  body?: string;
  ad_type?: string;
  url?: string;
  price_cents?: number;
  price?: unknown;
  images?: unknown;
  attributes?: Array<{ key?: string; value?: unknown; value_label?: unknown }> | Record<string, unknown>;
  location?: {
    city?: string; zipcode?: string; department_id?: string; department_name?: string;
    region_name?: string; lat?: number; lng?: number;
  };
  owner?: { user_id?: string; store_id?: string; type?: string; name?: string };
}

/**
 * Dates LBC : "2026-07-05 10:39:51" en heure Europe/Paris, sans fuseau.
 * Conversion en ISO UTC via l'offset réel (CET/CEST) de la date concernée.
 */
export function dateFromParis(s: string): string | undefined {
  const m = s?.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (!m) return undefined;
  const naive = `${m[1]!}T${m[2]!}Z`;
  const asUtc = new Date(naive);
  if (Number.isNaN(asUtc.getTime())) return undefined;
  // offset Paris (minutes) à cet instant : décalage entre l'heure rendue en Paris et l'UTC
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(asUtc).map((p) => [p.type, p.value]));
  const asParis = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
  );
  const offsetMs = asParis - asUtc.getTime();
  return new Date(asUtc.getTime() - offsetMs).toISOString();
}

function imagesOf(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter((u): u is string => typeof u === "string");
  }
  if (typeof raw === "object") {
    const urls = (raw as { urls?: unknown }).urls;
    if (Array.isArray(urls)) return urls.filter((u): u is string => typeof u === "string");
    const small = (raw as { small_url?: unknown }).small_url;
    if (typeof small === "string") return [small];
  }
  return [];
}

function priceCentsOf(ad: RawAd): number | undefined {
  if (typeof ad.price_cents === "number") return ad.price_cents;
  if (Array.isArray(ad.price)) {
    const first = ad.price[0];
    if (Array.isArray(first) && typeof first[0] === "number") return Math.round(first[0] * 100);
    if (typeof first === "number") return Math.round(first * 100);
  }
  return undefined;
}

function attributesOf(ad: RawAd): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Array.isArray(ad.attributes)) {
    for (const a of ad.attributes) {
      if (a?.key) out[a.key] = a.value_label ?? a.value;
    }
  } else if (ad.attributes && typeof ad.attributes === "object") {
    Object.assign(out, ad.attributes);
  }
  return out;
}

function isPurchaseInProgress(ad: RawAd, attrs: Record<string, unknown>): boolean {
  const haystack: string[] = [];
  if (typeof ad.status === "string") haystack.push(ad.status);
  for (const v of Object.values(attrs)) {
    if (typeof v === "string") haystack.push(v);
  }
  if (Array.isArray(ad.attributes)) {
    for (const a of ad.attributes) {
      if (typeof a.value === "string") haystack.push(a.value);
      if (typeof a.value_label === "string") haystack.push(a.value_label);
    }
  }
  return haystack.some((s) => {
    const f = s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return f.includes("achat en cours") || f.includes("achat en cour") || f.includes("reserve") || f.includes("reservé") || f.includes("vendu");
  });
}

export function normalizeAd(ad: RawAd, scrapedAt = new Date().toISOString()): Listing {
  const id = String(ad.list_id);
  const category = ad.category_name ?? ad.category_id;
  const attrs = attributesOf(ad);
  if (isPurchaseInProgress(ad, attrs)) attrs["_achatEnCours"] = true;
  return {
    id,
    url: ad.url ?? `https://www.leboncoin.fr/ad/${id}`,
    title: ad.subject ?? "(sans titre)",
    body: ad.body && ad.body.length > 0 ? ad.body : undefined,
    category,
    priceCents: priceCentsOf(ad),
    publishedAt: dateFromParis(ad.first_publication_date ?? ad.index_date ?? ""),
    scrapedAt,
    location: ad.location
      ? {
          city: ad.location.city,
          postalCode: ad.location.zipcode,
          department: ad.location.department_id,
        }
      : undefined,
    owner: ad.owner
      ? {
          id: ad.owner.user_id ?? ad.owner.store_id,
          name: ad.owner.name,
          type: ad.owner.type === "pro" ? "pro" : "private",
        }
      : undefined,
    images: imagesOf(ad.images),
    attributes: attrs,
    score: 0,
    source: "authorized-web",
  };
}

// ---------------------------------------------------------------------------
// Extraction __NEXT_DATA__
// ---------------------------------------------------------------------------

export interface SearchResult {
  ads: RawAd[];
  total: number;
  maxPages: number;
}

export function parseNextData(html: string): SearchResult {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("Page sans __NEXT_DATA__ — structure Leboncoin inattendue");
  const data = JSON.parse(m[1]!) as {
    props?: { pageProps?: { searchData?: { ads?: RawAd[]; total?: number; max_pages?: number } } };
  };
  const sd = data.props?.pageProps?.searchData;
  if (!sd) throw new Error("pageProps.searchData absent — quarantaine plutôt que liste vide");
  return { ads: sd.ads ?? [], total: sd.total ?? sd.ads?.length ?? 0, maxPages: sd.max_pages ?? 1 };
}

/**
 * Garde-fou deterministe anti-mauvais-modele (ex : une RTX 3080 remontee
 * par LBC dans une veille "rtx 2080 ti"). Le filtre LLM est la reference
 * semantique mais il echoue en mode ouvert (tout est garde en cas d'erreur
 * ou de reponse illisible). Ce test ne rejette que les numeros incompatibles :
 *  - le numero de modele de la requete (ex 2080) doit apparaitre dans le titre ;
 *  - si la requete exige Ti / Super, le titre doit les contenir aussi.
 * Une annonce "2080 ti" (sans "rtx") passe : seuls les jetons discriminants
 * (numero + suffixes) sont exiges, jamais "rtx"/"geforce".
 */
export function modelMatchesQuery(query: string, title: string): boolean {
  const q = query.toLowerCase();
  const t = title.toLowerCase();
  const qNum = q.match(/\b(\d{3,4})\b/);
  if (!qNum) return true;
  const num = qNum[1]!;
  if (!t.includes(num)) return false;
  const qRest = q.replace(num, " ");
  const tRest = t.replace(num, " ");
  const tiRe = /(^|[^a-z])ti([^a-z]|$)/;
  const superRe = /(^|[^a-z])super([^a-z]|$)/;
  if (tiRe.test(qRest) && !tiRe.test(tRest)) return false;
  if (superRe.test(qRest) && !superRe.test(tRest)) return false;
  return true;
}

/** Fraicheur exigee pour un drop Discord : seules les annonces VRAIMENT
 *  nouvelles (publiees dans les dernieres FRESH_HOURS) declenchent une alerte.
 *  Les vieilles annonces bumpees/remontees par LBC sont stockees
 *  silencieusement (jamais de drop sur du vieux). */
const FRESH_HOURS = 24;
export function isFreshListing(l: { publishedAt?: string }): boolean {
  if (!l.publishedAt) return false;
  const ts = Date.parse(l.publishedAt);
  if (Number.isNaN(ts)) return false;
  const now = Date.now();
  return ts <= now + 3600000 && now - ts <= FRESH_HOURS * 3600000;
}

// ---------------------------------------------------------------------------
// URL de recherche — paramètres validés en amont : text, category, price, tri date
// ---------------------------------------------------------------------------

export function buildSearchUrl(spec: SearchSpec, page: number): string {
  const p = new URLSearchParams();
  if (spec.query.trim() && spec.query.trim() !== "toutes annonces") p.set("text", spec.query.trim());
  if (spec.categoryIds?.[0]) p.set("category", spec.categoryIds[0]);
  if (spec.priceCents?.min !== undefined || spec.priceCents?.max !== undefined) {
    const min = Math.round((spec.priceCents?.min ?? 0) / 100);
    const max = spec.priceCents?.max !== undefined ? Math.round(spec.priceCents.max / 100) : 10000000;
    p.set("price", `${min}-${max}`);
  }
  // vendeur : écho muet mais actif (vérifié par les compteurs total_private/pro)
  if (spec.ownerTypes?.length === 1) p.set("owner_type", spec.ownerTypes[0] === "pro" ? "pro" : "private");
  if (spec.shippable) p.set("shippable", "1");
  if (spec.urgent) p.set("urgent", "1");
  if (spec.adTypes?.length === 1 && spec.adTypes[0] === "demand") p.set("ad_type", "demand");
  // attributs dynamiques : {min,max} → plage, scalaire/tableau → enum
  for (const [key, value] of Object.entries(spec.attributes ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const r = value as { min?: number; max?: number };
      if (r.min !== undefined || r.max !== undefined) {
        p.set(key, `${r.min ?? ""}-${r.max ?? ""}`);
      }
    } else if (Array.isArray(value)) {
      if (value.length > 0) p.set(key, value.join(","));
    } else if (value !== undefined && value !== null && String(value).length > 0) {
      p.set(key, String(value));
    }
  }
  // Tri chronologique strict : sort=date + order=desc. Re-mesuré le 22/08/2026 :
  // le filtre texte s'applique normalement avec sort=date (total ~17,9k vs
  // ~17,7k sans tri, annonces du jour en tête de page 1). L'ancien piège
  // « tout paramètre sort= fait ignorer text » n'existe plus côté serveur.
  p.set("sort", "date");
  p.set("order", "desc");
  // pagination : `page=N` 1-based (vérifié en live : page=2/3 → fenêtres
  // disjointes, 0 chevauchement ; `o` est IGNORÉ côté serveur — chaque
  // requête renvoyait la page 1 d'un flux qui bouge)
  if (page > 1) p.set("page", String(page));
  return `https://www.leboncoin.fr/recherche?${p.toString()}`;
}

// ---------------------------------------------------------------------------
// Engine live
// ---------------------------------------------------------------------------

export interface LiveEngineDeps {
  repos: Repos;
  bus: Bus;
  getProxy(): Promise<ProxyConfig | null>;
  /** Proxy stocké hors politique : repli automatique sur DataDome en direct. */
  getBackupProxy?(): Promise<ProxyConfig | null>;
  getAnysolverKey(): Promise<string | null>;
  getSessionProfile(): Promise<{ userAgent: string; cookies: Record<string, string> } | null>;
  /** Config LLM pour le filtre sémantique (llmFilter). Null = non configuré. */
  getLlm?(): Promise<{ baseUrl: string; apiKey: string; model: string } | null>;
}

const MAX_SOLVE_ATTEMPTS_PER_JOB = 2;
const MAX_AGE_DAYS = 14;

export class LiveEngine implements SearchEngine {
  readonly kind = "live" as const;

  constructor(private readonly deps: LiveEngineDeps) {}

  private async fetchPage(
    transport: WreqTransport,
    url: string,
    websiteUrl: string,
    anysolverKey: string | null,
    correlationId: string,
    solveAttempts: { count: number },
    proxy: ProxyConfig | null
  ): Promise<string> {
    const res = await transport.request({ url });
    if (res.status === 200) return res.body;

    const challenge = classifyDataDome({ status: res.status, url: websiteUrl, body: res.body });
    if (!challenge) {
      throw new Error(`HTTP ${res.status} inattendu sur ${url}`);
    }
    this.deps.bus.publish("challenge.detected", {
      kind: challenge.kind, reason: challenge.reason, correlationId,
    });

    if (challenge.kind === "abandon") {
      if (challenge.reason.startsWith("challenge inconnu") && solveAttempts.count < MAX_SOLVE_ATTEMPTS_PER_JOB) {
        // 403 sans URL identifiable : observé transitoire chez DataDome —
        // une unique reprise après backoff avant d'abandonner (jamais de boucle).
        solveAttempts.count++;
        await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 1500)));
        const retry = await transport.request({ url });
        if (retry.status === 200) return retry.body;
      }
      const err = new Error(`DataDome ${challenge.reason}`);
      (err as Error & { code?: string }).code = "datadome_rotate_ip";
      throw err;
    }
    if (!anysolverKey) {
      const err = new Error(
        `DataDome ${challenge.kind} rencontré et aucune clé AnySolver configurée — écran Système`
      );
      (err as Error & { code?: string }).code = "datadome_no_solver";
      throw err;
    }
    if (solveAttempts.count >= MAX_SOLVE_ATTEMPTS_PER_JOB) {
      const err = new Error(`DataDome : ${solveAttempts.count} tentatives épuisées pour ce job`);
      (err as Error & { code?: string }).code = "datadome_attempts_exhausted";
      throw err;
    }
    solveAttempts.count++;

    const client = new AnySolverClient({ apiKey: anysolverKey });
    const solved = await client.solve(
      {
        type: (challenge.kind === "interstitial"
          ? "DataDomeInterstitialCookieTask"
          : "DataDomeSliderCookieTask") as DataDomeTaskType,
        websiteURL: websiteUrl,
        userAgent: (transport as unknown as { userAgent: string }).userAgent,
        // même proxy que le transport : le cookie datadome est lié au couple IP+UA
        ...(proxy
          ? { proxy: { type: "http", host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password } }
          : {}),
        captchaURL: challenge.captchaUrl ?? undefined,
      },
      {
        onPoll: (info) =>
          this.deps.bus.publish("challenge.poll", { poll: info.poll, status: info.status, correlationId }),
      }
    );
    transport.cookies["datadome"] = solved.datadomeCookie;
    this.deps.bus.publish("challenge.solved", { elapsedMs: solved.elapsedMs, correlationId });

    // rejeu exact de la requête avec le cookie
    const retry = await transport.request({ url });
    if (retry.status === 200) return retry.body;
    const err = new Error(`Rejeu après challenge : HTTP ${retry.status}`);
    (err as Error & { code?: string }).code = "datadome_replay_failed";
    throw err;
  }

  async run(jobId: string, spec: SearchSpec, correlationId: string, watchId?: number | null): Promise<EngineRunResult> {
    const primary = await this.deps.getProxy();
    let lastErr: unknown;
    try {
      return await this.runOnce(jobId, spec, correlationId, primary, true, watchId);
    } catch (err) {
      lastErr = err;
      let code = (err as Error & { code?: string }).code ?? "";

      // DataDome avec le profil de session → repli empreinte propre (sans
      // cookies importés). Mesuré : un luat vieillissant déclenche des 403
      // sans captcha URL alors que le même fingerprint nu passe.
      const hasSession = await this.deps
        .getSessionProfile()
        .then((s) => s !== null)
        .catch(() => false);
      if (code.startsWith("datadome") && hasSession) {
        this.deps.bus.publish("challenge.failover_clean", { jobId, code, correlationId });
        logger.warn({ jobId, code }, "DataDome avec profil de session — repli empreinte propre");
        try {
          return await this.runOnce(jobId, spec, correlationId, primary, false, watchId);
        } catch (err2) {
          lastErr = err2;
          code = (err2 as Error & { code?: string }).code ?? "engine_error";
        }
      }

      // Toujours en échec → unique repli par le proxy stocké (hors politique),
      // puis quarantaine si ça échoue encore. Jamais de boucle.
      if (
        primary === null &&
        code.startsWith("datadome") &&
        this.deps.getBackupProxy
      ) {
        const backup = await this.deps.getBackupProxy().catch(() => null);
        if (backup) {
          this.deps.bus.publish("challenge.failover_proxy", {
            jobId, code, correlationId, proxy: `${backup.host}:${backup.port}`,
          });
          logger.warn({ jobId, code }, "DataDome en direct — repli proxy");
          try {
            return await this.runOnce(jobId, spec, correlationId, backup, false, watchId);
          } catch (err3) {
            lastErr = err3;
            code = (err3 as Error & { code?: string }).code ?? "engine_error";
            throw Object.assign(new Error(`DataDome : tous les replis épuisés (${code})`), { code });
          }
        }
      }
      throw lastErr;
    }
  }

  private async runOnce(
    jobId: string,
    spec: SearchSpec,
    correlationId: string,
    proxy: ProxyConfig | null,
    useSession: boolean,
    watchId?: number | null
  ): Promise<EngineRunResult> {
    // Sans texte, /recherche renvoie le flux générique national (catégories
    // mélangées) — ce n'est pas une recherche, on refuse plutôt que polluer.
    if (!spec.query.trim() || spec.query.trim() === "toutes annonces") {
      throw new Error("Requête vide : le flux générique n'est pas scrapé — précisez un texte de recherche");
    }
    // Session importée : cookies JWT expirés exclus (un luat périmé déclenche
    // un blocage DataDome sec, sans captcha). La recherche est publique — la
    // session n'apporte que l'empreinte, jamais l'autorisation.
    const rawSession = await this.deps.getSessionProfile();
    const session = useSession && rawSession ? freshenSession(rawSession) : null;
    const anysolverKey = await this.deps.getAnysolverKey();
    const transport = new WreqTransport({
      proxy: proxy ?? undefined,
      userAgent: session?.userAgent,
      cookies: session?.cookies,
    });

    const maxItems = Math.min(spec.maxItems ?? 200, 1000);
    const solveAttempts = { count: 0 };
    const collected: Listing[] = [];
    const seen = new Set<string>();
    let pages = 0;
    let oldestSeen = Number.POSITIVE_INFINITY;

    // `o` = numéro de page : on avance page par page jusqu'à maxPages du
    // serveur (plafond ~100), maxItems ou fin chronologique. Une page sans
    // aucune nouvelle annonce (flux qui bouge, param ignoré) arrête la boucle.
    let serverMaxPages = 1;
    for (let page = 1; page <= serverMaxPages; page++) {
      // respiration entre pages : les rafales déclenchent DataDome même avec
      // la bonne empreinte (constaté au stress test : 1×200 puis 403 en série)
      if (page > 1) await new Promise((r) => setTimeout(r, 700 + Math.floor(Math.random() * 700)));
      const url = buildSearchUrl(spec, page);
      const html = await this.fetchPage(
        transport, url, "https://www.leboncoin.fr/", anysolverKey, correlationId, solveAttempts, proxy
      );
      const result = parseNextData(html);
      pages++;
      serverMaxPages = Math.min(result.maxPages, 100);

      let newOnPage = 0;
      let newestOnPage = 0;
      for (const raw of result.ads) {
        if (collected.length >= maxItems) break;
        const listing = normalizeAd(raw);
        if (seen.has(listing.id)) continue;
        seen.add(listing.id);
        // revalidation locale des filtres non appliqués upstream
        if (spec.ownerTypes?.length && !spec.ownerTypes.includes(listing.owner?.type ?? "private")) continue;
        if (spec.locations?.departments?.length) {
          const dep = listing.location?.department;
          if (dep && !spec.locations.departments.includes(dep)) continue;
        }
        const ts = listing.publishedAt ? Date.parse(listing.publishedAt) : Number.NaN;
        if (!Number.isNaN(ts)) {
          // Rejet strict des annonces publiées il y a plus de MAX_AGE_DAYS (ex: 14 jours) :
          // une veille en temps réel ne doit JAMAIS alerter sur une annonce vieille de plusieurs mois
          if (Date.now() - ts > MAX_AGE_DAYS * 86_400_000) {
            continue;
          }
          oldestSeen = Math.min(oldestSeen, ts);
          newestOnPage = Math.max(newestOnPage, ts);
        }
        newOnPage++;
        collected.push({ ...listing, score: relevanceScore(spec.query, listing) });
      }

      // arrêt chronologique VRAI : en tri date desc, si la plus RÉCENTE de la
      // page dépasse l'âge max, tout ce qui est plus profond est plus vieux.
      // (l'ancienne règle sur la plus ancienne tuait la pagination à cause
      // d'un seul ad republishé/bumpé au milieu d'une page fraîche)
      if (collected.length >= maxItems) break;
      if (page > 1 && newOnPage === 0) break;
      if (result.ads.length === 0) break;
      if (newestOnPage > 0 && Date.now() - newestOnPage > MAX_AGE_DAYS * 86_400_000) break;
    }

    // score bonne affaire sur le lot collecté, puis seuil éventuel
    const prices = collected.map((l) => l.priceCents).filter((p): p is number => p !== undefined);
    let withDeal = collected.map((l) => ({
      ...l,
      dealScore: l.priceCents !== undefined && prices.length > 1
        ? Math.max(-1, Math.min(1, (medianOf(prices) - l.priceCents) / (medianOf(prices) || 1)))
        : undefined,
    }));
    if (spec.dealThreshold !== undefined) {
      withDeal = withDeal.filter((l) => (l.dealScore ?? -1) >= spec.dealThreshold!);
    }

    // anti-faux positifs déterministes (≤ 1 €, échange/troc/don)
    let junked = 0;
    if (spec.filterJunk !== false) {
      const before = withDeal.length;
      withDeal = withDeal.filter((l) => {
        if (isJunkListing(l)) {
          junked++;
          return false;
        }
        return true;
      });
      void before;
    }

    // garde-fou anti-mauvais-modele (deterministe, meme si le LLM echoue ouvert)
    if (spec.filterJunk !== false) {
      withDeal = withDeal.filter((l) => {
        if (!modelMatchesQuery(spec.query, l.title)) {
          junked++;
          return false;
        }
        return true;
      });
    }

    // filtre sémantique LLM : un seul appel groupé (Just Dance ≠ console…)
    let llmFiltered = 0;
    let llmApplied = false;
    if (spec.llmFilter && withDeal.length > 0 && this.deps.getLlm) {
      const llm = await this.deps.getLlm();
      if (llm) {
        const client = new LlmClient({ baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model });
        const res = await filterByRelevance(
          spec.query,
          withDeal.map((l) => ({ id: l.id, title: l.title, priceCents: l.priceCents })),
          (system, turns) => client.complete(system, turns)
        );
        llmApplied = res.applied;
        if (res.applied) {
          const before = withDeal.length;
          withDeal = withDeal.filter((l) => res.keptIds.has(l.id));
          llmFiltered = before - withDeal.length;
        }
      }
    }
    if (junked > 0 || llmFiltered > 0) {
      this.deps.bus.publish("search.filtered", { jobId, junked, llmFiltered, llmApplied, correlationId });
    }

    const outcomes = this.deps.repos.listings.upsertMany(withDeal);
    let newCount = 0;
    for (const o of outcomes) {
      // NEW-ONLY : un drop Discord = annonce fraichement publiee. Le vieux
      // (bump LBC, reprise apres quarantaine) est stocke sans alerter.
      if (o.isNew && isFreshListing(o.listing)) {
        newCount++;
        this.deps.bus.publish("listing.created", {
          listingId: o.listing.id, title: o.listing.title,
          priceCents: o.listing.priceCents ?? null, jobId, correlationId,
        });
        if (watchId !== undefined && watchId !== null) {
          this.deps.repos.webhooks.enqueueForWatch("listing.created", watchId, {
            listingId: o.listing.id,
            title: o.listing.title,
            priceCents: o.listing.priceCents ?? null,
            url: o.listing.url,
            city: o.listing.location?.city ?? null,
            body: o.listing.body ?? null,
            image: o.listing.images?.[0] ?? null,
          });
        }
      } else if (o.priceChanged) {
        this.deps.bus.publish("listing.price_changed", {
          listingId: o.listing.id, previousPriceCents: o.previousPriceCents,
          newPriceCents: o.listing.priceCents ?? null, jobId, correlationId,
        });
        // NEW-ONLY : pas de drop sur baisse de prix d'une vieille annonce.
        if (watchId !== undefined && watchId !== null && isFreshListing(o.listing)) {
          this.deps.repos.webhooks.enqueueForWatch("listing.price_changed", watchId, {
            listingId: o.listing.id,
            previousPriceCents: o.previousPriceCents,
            newPriceCents: o.listing.priceCents ?? null,
            title: o.listing.title,
            url: o.listing.url,
            body: o.listing.body ?? null,
            image: o.listing.images?.[0] ?? null,
          });
        }
      }
    }
    logger.info({ jobId, found: withDeal.length, collected: collected.length, newCount, pages }, "engine live terminé");
    return { found: withDeal.length, newCount, pageCount: pages, listingIds: withDeal.map((l) => l.id) };
  }
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Retire les cookies JWT expirés du bundle de session. Un cookie vieillissant
 * est pire qu'aucun cookie : DataDome bloque sec (403 sans captcha URL) sur
 * une session périmée alors que la même empreinte sans cookies passe.
 */
export function freshenSession<T extends { userAgent: string; cookies: Record<string, string> }>(
  session: T
): T {
  const cookies: Record<string, string> = {};
  let dropped = false;
  for (const [name, value] of Object.entries(session.cookies)) {
    if (!value.includes(".")) {
      cookies[name] = value;
      continue;
    }
    const exp = jwtExpiry(value);
    if (exp && exp.getTime() < Date.now()) {
      dropped = true;
      continue;
    }
    cookies[name] = value;
  }
  if (dropped) logger.warn("cookies de session expirés exclus de la recherche");
  return { ...session, cookies };
}
