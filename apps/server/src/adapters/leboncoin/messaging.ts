import { randomUUID } from "node:crypto";
import type { Conversation, Message } from "@lbc/contracts";
import type { CapturedKind, CapturedRequest, Repos } from "../../repos.js";
import type { ProxyConfig } from "../../domain/proxy.js";
import { WreqTransport } from "./wreq-transport.js";
import { classifyDataDome } from "./datadome.js";
import { logger } from "../../logger.js";

/**
 * Messagerie live — rejeu des contrats capturés (Chrome DevTools), jamais
 * d'endpoint deviné. Routing indépendant de la recherche : par défaut direct
 * (IP résidentielle du compte), proxy seulement si la politique le demande.
 */

export class MessagingError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "MessagingError";
  }
}

export interface MessagingDeps {
  repos: Repos;
  getSession(): Promise<{ userAgent: string; cookies: Record<string, string>; authHeader?: string } | null>;
  getProxy(): Promise<ProxyConfig | null>;
  /** Sur 401 : tente le rafraîchissement du bearer, true si renouvelé. */
  refresh?(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Rejeu d'une requête capturée : même URL, mêmes en-têtes sûrs, cookie frais
// ---------------------------------------------------------------------------

const REPLAY_DROP_HEADERS = new Set(["cookie", "content-length", "host", "connection", "accept-encoding"]);

export function buildReplayRequest(
  captured: CapturedRequest,
  session: { userAgent?: string; cookies: Record<string, string> },
  override?: { url?: string; body?: string; method?: string }
): { url: string; method: string; headers: Record<string, string>; body?: string } {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(captured.requestHeaders)) {
    if (!REPLAY_DROP_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  headers["User-Agent"] = headers["User-Agent"] ?? headers["user-agent"] ?? session.userAgent ?? "Mozilla/5.0";
  const cookie = Object.entries(session.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  if (cookie) headers["Cookie"] = cookie;
  return {
    url: override?.url ?? captured.url,
    method: override?.method ?? captured.method,
    headers,
    body: override?.body ?? captured.postData ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// HAL : pagination et normalisation tolérante
// ---------------------------------------------------------------------------

interface HalConversation {
  id?: string | number;
  conversation_id?: string | number;
  listing_id?: string | number;
  ad_id?: string | number;
  user?: { username?: string; name?: string; id?: string } | string;
  alias?: string;
  date?: string;
  last_message_date?: string;
  last_message_sent_at?: string;
  created_at?: string;
  unread_count?: number;
  unseen_counter?: number;
  /** dialecte v3 (messaging-items-api) */
  item?: { id?: string | number; type?: string; status?: string } | null;
  partners?: Array<{ name?: string; id?: string }>;
  ad?: { subject?: string; title?: string; price?: number | { amount?: number } } | null;
  _links?: Record<string, { href?: string }>;
  _embedded?: Record<string, unknown>;
}

/** Extrait un tableau quel que soit le dialecte HAL/v3 rencontré. */
export function extractConversations(json: unknown): HalConversation[] {
  if (Array.isArray(json)) return json as HalConversation[];
  if (!json || typeof json !== "object") return [];
  const j = json as Record<string, unknown>;
  const embedded = j["_embedded"] as Record<string, unknown> | undefined;
  if (embedded) {
    for (const key of ["conversation-list", "conversations", "conversation", "items", "message", "messages"]) {
      const v = embedded[key];
      if (Array.isArray(v)) return v as HalConversation[];
    }
  }
  for (const key of ["conversations", "items", "data", "messages"]) {
    const v = j[key];
    if (Array.isArray(v)) return v as HalConversation[];
  }
  return [];
}

export function nextHalLink(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const links = (json as Record<string, unknown>)["_links"] as Record<string, { href?: string }> | undefined;
  return links?.next?.href ?? null;
}

export function normalizeConversation(c: HalConversation, listingTitleOf?: (id: string) => string | null): { conversation: Conversation; links: Record<string, string> } {
  const id = String(c.id ?? c.conversation_id ?? "");
  const other =
    typeof c.user === "string" ? c.user
    : (c.user?.username ?? c.user?.name ?? c.partners?.[0]?.name ?? "inconnu");
  const price = c.ad?.price;
  const links: Record<string, string> = {};
  for (const [k, v] of Object.entries(c._links ?? {})) {
    if (v?.href) links[k] = v.href;
  }
  const listingId =
    c.listing_id != null ? String(c.listing_id)
    : c.ad_id != null ? String(c.ad_id)
    : c.item?.id != null ? String(c.item.id)
    : null;
  return {
    conversation: {
      id,
      listingId,
      listingTitle: c.ad?.subject ?? c.ad?.title ?? (listingId ? (listingTitleOf?.(listingId) ?? null) : null),
      listingPriceCents:
        typeof price === "number" ? Math.round(price * 100)
        : price && typeof price === "object" && typeof price.amount === "number" ? Math.round(price.amount * 100)
        : null,
      otherUser: other,
      lastMessageAt: c.last_message_sent_at ?? c.date ?? c.last_message_date ?? c.created_at ?? new Date().toISOString(),
      unreadCount: c.unread_count ?? c.unseen_counter ?? 0,
      classification: null,
    },
    links,
  };
}

/** Pagination : dialecte v3 (metadata.next_page_hash) ou HAL (_links.next). */
export function nextConversationPageUrl(json: unknown, currentUrl: string): string | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  const metadata = j["metadata"] as { next_page_hash?: string } | undefined;
  if (metadata && typeof metadata.next_page_hash === "string" && metadata.next_page_hash.length > 0) {
    const sep = currentUrl.includes("?") ? "&" : "?";
    return `${currentUrl}${sep}page_hash=${encodeURIComponent(metadata.next_page_hash)}`;
  }
  return nextHalLink(json);
}

// ---------------------------------------------------------------------------
// Contrats synthétiques — la connexion Chrome n'exige AUCUN envoi manuel
// ---------------------------------------------------------------------------

/**
 * Les endpoints vérifiés en live (inbox v3, détail HAL, envoi POST) sont
 * connus et stables : à l'import d'une session, on les matérialise en
 * contrats capturés si l'opérateur n'en a pas capturés en naviguant. Le
 * rejeu reste identique (cookie + bearer frais du coffre par-dessus). Une
 * vraie capture, si elle existe, prime toujours.
 */
export function ensureSyntheticContracts(
  repos: Repos,
  userId: string,
  userAgent?: string
): { inserted: string[] } {
  const inserted: string[] = [];
  const ua = userAgent ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const baseHeaders: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    origin: "https://www.leboncoin.fr",
    referer: "https://www.leboncoin.fr/messagerie/",
    apptype: "leboncoin",
    "user-agent": ua,
  };
  const CONV_ID = "00000000-0000-0000-0000-000000000000";

  const has = (kind: CapturedKind, re: RegExp) =>
    repos.captured.list(100, kind).some((c) => re.test(c.url));

  // 1. Inbox v3
  if (!has("inbox", /\/conversations(?:\?|$)/)) {
    repos.captured.insert({
      method: "GET",
      url: "https://api.leboncoin.fr/api/messaging-items-api/v3/conversations",
      status: 200,
      requestHeaders: { ...baseHeaders },
      cookieNames: [],
      postData: null,
    });
    inserted.push("inbox");
  }
  // 2. Détail HAL (l'id de conversation est substitué au rejeu)
  if (!has("inbox", /\/hal\/[^/]+\/conversations\/[^/?]+/)) {
    repos.captured.insert({
      method: "GET",
      url: `https://api.leboncoin.fr/api/messaging/proxy/api/v1/hal/${encodeURIComponent(userId)}/conversations/${CONV_ID}`,
      status: 200,
      requestHeaders: { ...baseHeaders },
      cookieNames: [],
      postData: null,
    });
    inserted.push("hal");
  }
  // 3. Envoi (id de conversation substitué, texte remplacé, clientMessageId régénéré)
  if (!has("send", /\/conversations\/[^/]+\/messages/)) {
    repos.captured.insert({
      method: "POST",
      url: `https://api.leboncoin.fr/api/messaging/proxy/api/v1/hal/${encodeURIComponent(userId)}/conversations/${CONV_ID}/messages`,
      status: 201,
      requestHeaders: { ...baseHeaders, "content-type": "application/json" },
      cookieNames: [],
      postData: JSON.stringify({ clientMessageId: "00000000-0000-4000-8000-000000000000", text: "contrat synthétique", attachments: [] }),
    });
    inserted.push("send");
  }
  if (inserted.length > 0) {
    logger.info({ inserted }, "contrats messagerie synthétiques créés (aucun envoi manuel requis)");
  }
  return { inserted };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class MessagingAdapter {
  constructor(private readonly deps: MessagingDeps) {}

  private async transport(): Promise<WreqTransport> {
    const session = await this.deps.getSession();
    if (!session) throw new MessagingError("Session Leboncoin non importée — connexion Chrome requise", "no_session");
    const proxy = await this.deps.getProxy();
    return new WreqTransport({ proxy: proxy ?? undefined, userAgent: session.userAgent, cookies: session.cookies });
  }

  /** Bearer courant du coffre — prioritaire sur l'en-tête capturé (vielli). */
  private async currentAuth(): Promise<string | null> {
    const session = await this.deps.getSession();
    return session?.authHeader ?? null;
  }

  private async replay(urlOverride?: string, bodyOverride?: string): Promise<{
    url: string; method: string; headers: Record<string, string>; body?: string;
    captured: CapturedRequest; transport: WreqTransport;
  }> {
    const all = this.deps.repos.captured.list(60, "inbox");
    const captured =
      all.find((c) => c.method === "GET" && /\/conversations(?:\?|$)/.test(c.url)) ?? all.find((c) => c.method === "GET");
    if (!captured) throw new MessagingError("Contrat inbox non capturé", "no_captured_contract");
    const transport = await this.transport();
    const auth = await this.currentAuth();
    const replay = buildReplayRequest(
      captured,
      { cookies: (transport as unknown as { cookies: Record<string, string> }).cookies },
      { ...(urlOverride ? { url: urlOverride } : {}), ...(bodyOverride ? { body: bodyOverride } : {}) }
    );
    if (auth) replay.headers["authorization"] = auth;
    return { ...replay, captured, transport };
  }

  /** Liste des conversations : rejeu du contrat v3 capturé + pagination
   *  page_hash/HAL. Sur 401 : rafraîchissement du bearer puis unique reprise. */
  async fetchConversations(maxPages = 10): Promise<Array<{ conversation: Conversation; links: Record<string, string> }>> {
    const { transport } = await this.replay();
    const listUrl = this.deps.repos.captured
      .list(60, "inbox")
      .find((c) => c.method === "GET" && /\/conversations(?:\?|$)/.test(c.url))?.url;
    if (!listUrl) {
      throw new MessagingError(
        "Contrat inbox non capturé — ouvrez la messagerie Leboncoin pendant une capture Chrome (Système → Connexion Chrome)",
        "no_captured_contract"
      );
    }

    const out: Array<{ conversation: Conversation; links: Record<string, string> }> = [];
    let url: string | null = listUrl;

    const fetchPage = async (target: string) => {
      const r = await this.replay(target);
      let res = await r.transport.request({ url: r.url, method: r.method, headers: r.headers });
      // DataDome transitoire (observé pendant les fenêtres de blocage) :
      // une unique reprise après backoff avant d'abandonner proprement
      if (res.status === 403) {
        await new Promise((r2) => setTimeout(r2, 2500 + Math.floor(Math.random() * 1500)));
        const retry = await this.replay(target);
        res = await retry.transport.request({ url: retry.url, method: retry.method, headers: retry.headers });
      }
      return res;
    };

    for (let page = 0; page < maxPages && url; page++) {
      let res = await fetchPage(url);
      if (res.status === 401 && this.deps.refresh && (await this.deps.refresh())) {
        res = await fetchPage(url); // bearer renouvelé — une seule reprise
      }
      if (res.status === 403) {
        const ch = classifyDataDome({ status: 403, url, body: res.body });
        throw new MessagingError(`DataDome sur la messagerie (${ch?.reason ?? "403"})`, "datadome");
      }
      if (res.status === 401) {
        throw new MessagingError("Bearer expiré et rafraîchissement impossible — Système → Chrome pour se reconnecter", "unauthorized");
      }
      if (res.status !== 200) {
        throw new MessagingError(`Inbox HTTP ${res.status}`, `inbox_http_${res.status}`);
      }
      let json: unknown;
      try {
        json = JSON.parse(res.body);
      } catch {
        throw new MessagingError("Réponse inbox non JSON — contrat à recapturer", "bad_contract");
      }
      for (const raw of extractConversations(json)) {
        const n = normalizeConversation(raw, (id) => this.deps.repos.listings.byId(id)?.title ?? null);
        if (n.conversation.id) out.push(n);
      }
      url = nextConversationPageUrl(json, url);
    }
    return out;
  }

  /** Messages d'une conversation : lien HAL stocké, sinon rejeu de l'URL de
   *  détail capturée avec substitution de l'identifiant de conversation. */
  async fetchMessages(conversationId: string, links: Record<string, string>): Promise<Message[]> {
    let href = links["messages"] ?? links["self"] ?? null;
    if (!href) {
      // URL de détail HAL capturée : /hal/<userId>/conversations/<convId>[...]
      const detail = this.deps.repos.captured
        .list(60, "inbox")
        .find((c) => c.method === "GET" && /\/hal\/[^/]+\/conversations\/[^/?]+/.test(c.url));
      if (detail) {
        href = detail.url.replace(/(\/conversations\/)[^/?]+/i, `$1${encodeURIComponent(conversationId)}`);
      }
    }
    if (!href) throw new MessagingError("Aucune URL de messages connue pour cette conversation", "no_hal_link");

    const r = await this.replay(href);
    let res = await r.transport.request({ url: r.url, method: "GET", headers: r.headers });
    if (res.status === 401 && this.deps.refresh && (await this.deps.refresh())) {
      const retry = await this.replay(href);
      res = await retry.transport.request({ url: retry.url, method: "GET", headers: retry.headers });
    }
    if (res.status !== 200) throw new MessagingError(`Messages HTTP ${res.status}`, `messages_http_${res.status}`);
    const json = JSON.parse(res.body) as unknown;
    // même extraction tolérante que l'inbox, puis lecture non typée :
    // le dialecte exact des messages n'est connu qu'après capture réelle
    const items = extractConversations(json) as unknown as Array<Record<string, unknown>>;
    return items.map((m, i) => {
      const embedded = (m["_embedded"] ?? {}) as Record<string, unknown>;
      const body =
        typeof m["message"] === "string" ? m["message"]
        : typeof embedded["message"] === "string" ? embedded["message"]
        : typeof m["text"] === "string" ? m["text"]
        : typeof m["body"] === "string" ? m["body"] : "";
      const fromMe = m["outgoing"] === true || m["from_me"] === true || m["sender"] === "me";
      return {
        id: String(m["id"] ?? m["message_id"] ?? m["clientMessageId"] ?? `hal-${i}`),
        conversationId: String(m["conversation_id"] ?? m["conversationId"] ?? conversationId),
        direction: fromMe ? ("out" as const) : ("in" as const),
        senderId: typeof m["sender_id"] === "string" ? m["sender_id"] : null,
        senderName: null,
        body,
        sentAt: String(m["sentAt"] ?? m["date"] ?? m["created_at"] ?? new Date().toISOString()),
        auto: false,
        deliveryStatus: "sent" as const,
      };
    }).filter((m) => m.body.length > 0);
  }

  /**
   * Envoi : rejeu du POST capturé avec substitution du texte si le corps est un
   * JSON avec un champ message évident. Sans capture → erreur explicite,
   * jamais d'envoi deviné.
   */
  async sendMessage(conversationId: string, text: string, _links: Record<string, string>): Promise<{ sent: boolean; detail: string }> {
    // Contrat d'envoi : POST sur …/conversations/<id>/messages — jamais un
    // typing/read/credentials (classés 'other', mais on re-filtre par sécurité)
    const captured = this.deps.repos.captured
      .list(100, "send")
      .find((c) => c.method === "POST" && /\/conversations\/[^/]+\/messages/.test(c.url));
    if (!captured) {
      throw new MessagingError(
        "Contrat d'envoi non capturé — envoyez un message à la main pendant une capture Chrome, le rejeu prendra le relais",
        "no_captured_send"
      );
    }
    const transport = await this.transport();
    const auth = await this.currentAuth();
    // Substitution TOUJOURS active : la cible est la conversation demandée,
    // jamais celle de la capture
    const url = captured.url.replace(/(\/conversations\/)[^/?]+/i, `$1${encodeURIComponent(conversationId)}`);
    let body: string | undefined;

    if (captured.postData) {
      try {
        const parsed = JSON.parse(captured.postData) as Record<string, unknown>;
        const msgKey = ["message", "text", "body", "content"].find((k) => typeof parsed[k] === "string");
        if (!msgKey) {
          throw new MessagingError("Corps d'envoi capturé sans champ message identifiable — capture plus récente requise", "bad_send_contract");
        }
        const rebuilt = { ...parsed, [msgKey]: text };
        // clientMessageId : identifiant de déduplication côté Leboncoin —
        // régénéré à chaque envoi, jamais le même que la capture
        if (typeof rebuilt["clientMessageId"] === "string" || !("clientMessageId" in rebuilt)) {
          rebuilt["clientMessageId"] = randomUUID();
        }
        // conversation dans le corps ou l'URL : remplace si placeholder évident
        if (typeof rebuilt["conversationId"] === "string") rebuilt["conversationId"] = conversationId;
        body = JSON.stringify(rebuilt);
      } catch (err) {
        if (err instanceof MessagingError) throw err;
        throw new MessagingError("Corps d'envoi capturé non JSON — capture plus récente requise", "bad_send_contract");
      }
    }

    const replay = buildReplayRequest(captured, {
      cookies: (transport as unknown as { cookies: Record<string, string> }).cookies,
    }, { url, body });
    if (auth) replay.headers["authorization"] = auth;

    const fire = () => transport.request({ url: replay.url, method: "POST", headers: replay.headers, body: replay.body });
    let res = await fire();
    if (res.status === 401 && this.deps.refresh && (await this.deps.refresh())) {
      const fresh = await this.currentAuth();
      if (fresh) replay.headers["authorization"] = fresh;
      res = await fire();
    }
    if (res.status === 403) {
      throw new MessagingError("DataDome sur l'envoi — IP à revoir", "datadome");
    }
    if (res.status === 401) {
      throw new MessagingError("Bearer expiré — rafraîchissement impossible, Système → Chrome", "unauthorized");
    }
    if (res.status < 200 || res.status >= 300) {
      throw new MessagingError(`Envoi HTTP ${res.status}`, `send_http_${res.status}`);
    }
    logger.info({ conversationId }, "message envoyé (rejeu contrat capturé)");
    return { sent: true, detail: `HTTP ${res.status}` };
  }
}
