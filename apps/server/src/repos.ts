import type {
  Conversation,
  Delivery,
  EventName,
  Listing,
  Message,
  PricePoint,
  SearchJob,
  SearchSpec,
  SseEvent,
  Watch,
  Webhook,
} from "@lbc/contracts";
import { Db } from "./db.js";

export type { Delivery };

const iso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

interface ListingRow {
  id: string; url: string; title: string; body: string | null; category: string | null;
  price_cents: number | null; published_at: string | null; first_seen_at: string;
  last_seen_at: string; city: string | null; postal_code: string | null; department: string | null;
  owner_id: string | null; owner_name: string | null; owner_type: string | null;
  images_json: string; attributes_json: string; score: number; deal_score: number | null;
  source: string;
}

function rowToListing(r: ListingRow): Listing {
  return {
    id: r.id,
    url: r.url,
    title: r.title,
    body: r.body ?? undefined,
    category: r.category ?? undefined,
    priceCents: r.price_cents ?? undefined,
    publishedAt: r.published_at ?? undefined,
    scrapedAt: r.last_seen_at,
    location: r.city || r.postal_code || r.department
      ? { city: r.city ?? undefined, postalCode: r.postal_code ?? undefined, department: r.department ?? undefined }
      : undefined,
    owner: r.owner_id || r.owner_name || r.owner_type
      ? {
          id: r.owner_id ?? undefined,
          name: r.owner_name ?? undefined,
          type: (r.owner_type as "private" | "pro" | null) ?? undefined,
        }
      : undefined,
    images: JSON.parse(r.images_json) as string[],
    attributes: JSON.parse(r.attributes_json) as Record<string, unknown>,
    score: r.score,
    dealScore: r.deal_score ?? undefined,
    source: r.source as Listing["source"],
  };
}

export class ListingsRepo {
  constructor(private readonly db: Db) {}

  upsertMany(listings: Listing[]): Array<{ isNew: boolean; priceChanged: boolean; previousPriceCents: number | null; listing: Listing }> {
    const results: Array<{ isNew: boolean; priceChanged: boolean; previousPriceCents: number | null; listing: Listing }> = [];
    for (const l of listings) {
      const existing = this.db.get<ListingRow>(
        "SELECT * FROM listings WHERE id = ?",
        l.id
      );
      const now = iso();
      this.db.run(
        `INSERT INTO listings (id, url, title, body, category, price_cents, published_at, first_seen_at, last_seen_at,
           city, postal_code, department, owner_id, owner_name, owner_type, images_json, attributes_json, score, deal_score, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           url = excluded.url, title = excluded.title, body = excluded.body,
           category = excluded.category, price_cents = excluded.price_cents,
           published_at = excluded.published_at, last_seen_at = excluded.last_seen_at,
           city = excluded.city, postal_code = excluded.postal_code, department = excluded.department,
           owner_id = excluded.owner_id, owner_name = excluded.owner_name, owner_type = excluded.owner_type,
           images_json = excluded.images_json, attributes_json = excluded.attributes_json,
           score = excluded.score, deal_score = excluded.deal_score, source = excluded.source`,
        l.id, l.url, l.title, l.body ?? null, l.category ?? null, l.priceCents ?? null,
        l.publishedAt ?? null, existing ? existing.first_seen_at : now, now,
        l.location?.city ?? null, l.location?.postalCode ?? null, l.location?.department ?? null,
        l.owner?.id ?? null, l.owner?.name ?? null, l.owner?.type ?? null,
        JSON.stringify(l.images), JSON.stringify(l.attributes), l.score, l.dealScore ?? null, l.source
      );
      const priceChanged =
        !!existing && existing.price_cents !== null && l.priceCents !== undefined && existing.price_cents !== l.priceCents;
      if (l.priceCents !== undefined) {
        this.db.run(
          "INSERT OR IGNORE INTO price_history (listing_id, price_cents, observed_at) VALUES (?, ?, ?)",
          l.id, l.priceCents, now
        );
      }
      results.push({
        isNew: !existing,
        priceChanged,
        previousPriceCents: priceChanged ? existing!.price_cents : null,
        listing: l,
      });
    }
    return results;
  }

  byId(id: string): Listing | undefined {
    const row = this.db.get<ListingRow>("SELECT * FROM listings WHERE id = ?", id);
    return row ? rowToListing(row) : undefined;
  }

  priceHistory(id: string): PricePoint[] {
    return this.db.all<{ listing_id: string; price_cents: number; observed_at: string }>(
      "SELECT * FROM price_history WHERE listing_id = ? ORDER BY observed_at ASC",
      id
    ).map((r) => ({ priceCents: r.price_cents, observedAt: r.observed_at }));
  }

  search(filters: {
    query?: string; priceMin?: number; priceMax?: number; ownerType?: "private" | "pro";
    shippable?: boolean; department?: string; category?: string; watchId?: number;
    limit: number; offset: number;
  }): { items: Listing[]; total: number } {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filters.watchId !== undefined) {
      where.push("id IN (SELECT listing_id FROM watch_listings WHERE watch_id = ?)");
      params.push(filters.watchId);
    }
    // Recherche TOKENISÉE (mots en ET), comme le site : « pixel 8 » doit
    // retrouver « Pixel 8a », « Pixel 8 Pro »… le LIKE exact en sous-chaîne
    // cachait des résultats que l'engine avait réellement trouvés.
    if (filters.query) {
      const tokens = filters.query
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .slice(0, 6);
      for (const token of tokens) {
        const like = `%${token.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        where.push(`(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')`);
        params.push(like, like);
      }
    }
    if (filters.priceMin !== undefined) { where.push("price_cents >= ?"); params.push(filters.priceMin); }
    if (filters.priceMax !== undefined) { where.push("price_cents <= ?"); params.push(filters.priceMax); }
    if (filters.ownerType) { where.push("owner_type = ?"); params.push(filters.ownerType); }
    if (filters.shippable) { where.push("json_extract(attributes_json, '$.shippable') = 1"); }
    if (filters.department) { where.push("department = ?"); params.push(filters.department); }
    if (filters.category) { where.push("category = ?"); params.push(filters.category); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM listings ${whereSql}`, ...params))?.n ?? 0;
    // Tri DB par date de publication (pas last_seen) pour que le top 10 soit vraiment
    // les plus récents ; le tri fin en route (localSort) affine selon sort/dir demandés.
    const items = this.db
      .all<ListingRow>(
        `SELECT * FROM listings ${whereSql} ORDER BY CASE WHEN published_at IS NULL THEN 1 ELSE 0 END, published_at DESC, last_seen_at DESC LIMIT ? OFFSET ?`,
        ...params, filters.limit, filters.offset
      )
      .map(rowToListing);
    return { items, total };
  }

  count(): number {
    return (this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM listings"))?.n ?? 0;
  }

  peerPrices(category: string | null): number[] {
    return this.db
      .all<{ p: number }>(
        category
          ? "SELECT price_cents AS p FROM listings WHERE category = ? AND price_cents IS NOT NULL"
          : "SELECT price_cents AS p FROM listings WHERE price_cents IS NOT NULL",
        ...(category ? [category] : [])
      )
      .map((r) => r.p);
  }
}

// ---------------------------------------------------------------------------
// Watches
// ---------------------------------------------------------------------------

interface WatchRow {
  id: number; name: string; spec_json: string; enabled: number;
  cadence_minutes: number; last_run_at: string | null; last_status: string | null; created_at: string;
}

function rowToWatch(r: WatchRow): Watch {
  return {
    id: r.id,
    name: r.name,
    spec: JSON.parse(r.spec_json) as SearchSpec,
    enabled: r.enabled === 1,
    cadenceMinutes: r.cadence_minutes,
    lastRunAt: r.last_run_at,
    lastStatus: r.last_status,
    createdAt: r.created_at,
  };
}

export class WatchesRepo {
  constructor(private readonly db: Db) {}

  list(): Watch[] {
    return this.db.all<WatchRow>("SELECT * FROM watches ORDER BY id").map(rowToWatch);
  }

  byId(id: number): Watch | undefined {
    const r = this.db.get<WatchRow>("SELECT * FROM watches WHERE id = ?", id);
    return r ? rowToWatch(r) : undefined;
  }

  create(name: string, spec: SearchSpec, cadenceMinutes = 10): Watch {
    const res = this.db.run(
      "INSERT INTO watches (name, spec_json, enabled, cadence_minutes, created_at) VALUES (?, ?, 1, ?, ?)",
      name, JSON.stringify(spec), cadenceMinutes, iso()
    );
    return this.byId(Number(res.lastInsertRowid))!;
  }

  update(id: number, patch: { name?: string; spec?: SearchSpec; enabled?: boolean; cadenceMinutes?: number }): Watch | undefined {
    const w = this.byId(id);
    if (!w) return undefined;
    this.db.run(
      "UPDATE watches SET name = ?, spec_json = ?, enabled = ?, cadence_minutes = ? WHERE id = ?",
      patch.name ?? w.name,
      JSON.stringify(patch.spec ?? w.spec),
      (patch.enabled ?? w.enabled) ? 1 : 0,
      patch.cadenceMinutes ?? w.cadenceMinutes,
      id
    );
    return this.byId(id);
  }

  delete(id: number): boolean {
    return Number(this.db.run("DELETE FROM watches WHERE id = ?", id).changes) > 0;
  }

  markRun(id: number, status: string): void {
    this.db.run("UPDATE watches SET last_run_at = ?, last_status = ? WHERE id = ?", iso(), status, id);
  }

  /** Relie un run de veille à ses résultats (idempotent, multi-veilles OK). */
  linkListings(watchId: number, listingIds: string[]): void {
    if (listingIds.length === 0) return;
    const stmt = this.db.raw.prepare(
      "INSERT OR IGNORE INTO watch_listings (watch_id, listing_id, seen_at) VALUES (?, ?, ?)"
    );
    for (const listingId of listingIds) stmt.run(watchId, listingId, iso());
  }

  listingCount(watchId: number): number {
    return (this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM watch_listings WHERE watch_id = ?", watchId))?.n ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Search jobs
// ---------------------------------------------------------------------------

interface JobRow {
  id: string; watch_id: number | null; spec_json: string; status: string;
  page_count: number | null; items_found: number | null; items_new: number | null;
  error_code: string | null; error_message: string | null; error_retryable: number | null;
  started_at: string; finished_at: string | null; correlation_id: string;
}

function rowToJob(r: JobRow): SearchJob {
  return {
    id: r.id,
    watchId: r.watch_id,
    status: r.status as SearchJob["status"],
    pageCount: r.page_count,
    itemsFound: r.items_found,
    itemsNew: r.items_new,
    error: r.error_code
      ? { code: r.error_code, message: r.error_message ?? "", retryable: r.error_retryable === 1 }
      : null,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    correlationId: r.correlation_id,
  };
}

export class JobsRepo {
  constructor(private readonly db: Db) {}

  create(id: string, watchId: number | null, spec: SearchSpec, correlationId: string): SearchJob {
    this.db.run(
      `INSERT INTO search_jobs (id, watch_id, spec_json, status, started_at, correlation_id)
       VALUES (?, ?, ?, 'running', ?, ?)`,
      id, watchId, JSON.stringify(spec), iso(), correlationId
    );
    return this.byId(id)!;
  }

  byId(id: string): SearchJob | undefined {
    const r = this.db.get<JobRow>("SELECT * FROM search_jobs WHERE id = ?", id);
    return r ? rowToJob(r) : undefined;
  }

  recent(limit = 20): SearchJob[] {
    return this.db
      .all<JobRow>("SELECT * FROM search_jobs ORDER BY started_at DESC LIMIT ?", limit)
      .map(rowToJob);
  }

  finish(
    id: string,
    status: SearchJob["status"],
    data: { pageCount?: number; itemsFound?: number; itemsNew?: number; error?: { code: string; message: string; retryable: boolean } }
  ): void {
    this.db.run(
      `UPDATE search_jobs SET status = ?, page_count = ?, items_found = ?, items_new = ?,
         error_code = ?, error_message = ?, error_retryable = ?, finished_at = ? WHERE id = ?`,
      status,
      data.pageCount ?? null,
      data.itemsFound ?? null,
      data.itemsNew ?? null,
      data.error?.code ?? null,
      data.error?.message ?? null,
      data.error ? (data.error.retryable ? 1 : 0) : null,
      iso(),
      id
    );
  }
}

// ---------------------------------------------------------------------------
// Conversations & messages
// ---------------------------------------------------------------------------

export class ConversationsRepo {
  constructor(private readonly db: Db) {}

  list(): Conversation[] {
    return this.db.all<Conversation>(
      "SELECT id, listing_id AS listingId, listing_title AS listingTitle, listing_price_cents AS listingPriceCents, other_user AS otherUser, last_message_at AS lastMessageAt, unread_count AS unreadCount, classification FROM conversations ORDER BY last_message_at DESC"
    );
  }

  byId(id: string): Conversation | undefined {
    return this.db.get<Conversation>(
      "SELECT id, listing_id AS listingId, listing_title AS listingTitle, listing_price_cents AS listingPriceCents, other_user AS otherUser, last_message_at AS lastMessageAt, unread_count AS unreadCount, classification FROM conversations WHERE id = ?",
      id
    );
  }

  /** Liens HAL de la conversation (stockés à la sync live). */
  linksOf(id: string): Record<string, string> {
    const row = this.db.get<{ hal_links_json: string | null }>(
      "SELECT hal_links_json FROM conversations WHERE id = ?",
      id
    );
    if (!row?.hal_links_json) return {};
    try {
      return JSON.parse(row.hal_links_json) as Record<string, string>;
    } catch {
      return {};
    }
  }

  /** Sync live : upsert d'une conversation HAL avec ses liens. */
  upsertLive(conv: Conversation, links: Record<string, string>): { isNew: boolean } {
    const existing = this.byId(conv.id);
    this.db.run(
      `INSERT INTO conversations (id, listing_id, listing_title, listing_price_cents, other_user, last_message_at, unread_count, classification, hal_links_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         listing_id = excluded.listing_id, listing_title = excluded.listing_title,
         listing_price_cents = excluded.listing_price_cents, other_user = excluded.other_user,
         last_message_at = excluded.last_message_at, unread_count = excluded.unread_count,
         hal_links_json = excluded.hal_links_json`,
      conv.id, conv.listingId, conv.listingTitle, conv.listingPriceCents, conv.otherUser,
      conv.lastMessageAt, conv.unreadCount, conv.classification, JSON.stringify(links)
    );
    return { isNew: !existing };
  }

  messages(conversationId: string): Message[] {
    return this.db.all<Message>(
      `SELECT id, conversation_id AS conversationId, direction, sender_id AS senderId,
              sender_name AS senderName, body, sent_at AS sentAt, auto, delivery_status AS deliveryStatus
       FROM messages WHERE conversation_id = ? ORDER BY sent_at ASC`,
      conversationId
    );
  }

  /** Insertion idempotente : même id → ignorée, retourne l'existant. */
  insertMessage(m: Message): { inserted: boolean; message: Message } {
    const res = this.db.run(
      `INSERT INTO messages (id, conversation_id, direction, sender_id, sender_name, body, sent_at, auto, delivery_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      m.id, m.conversationId, m.direction, m.senderId, m.senderName, m.body, m.sentAt, m.auto ? 1 : 0, m.deliveryStatus
    );
    if (Number(res.changes) === 0) {
      return { inserted: false, message: this.db.get<Message>(
        "SELECT id, conversation_id AS conversationId, direction, sender_id AS senderId, sender_name AS senderName, body, sent_at AS sentAt, auto, delivery_status AS deliveryStatus FROM messages WHERE id = ?",
        m.id
      )! };
    }
    this.db.run("UPDATE conversations SET last_message_at = ? WHERE id = ?", m.sentAt, m.conversationId);
    return { inserted: true, message: m };
  }

  countOutboxToday(): number {
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const r = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM messages WHERE direction = 'out' AND sent_at >= ?",
      midnight.toISOString()
    );
    return r?.n ?? 0;
  }

  countRecentHour(conversationId: string): number {
    const since = new Date(Date.now() - 3600_000).toISOString();
    const r = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND direction = 'out' AND sent_at >= ?",
      conversationId, since
    );
    return r?.n ?? 0;
  }

  count(): number {
    return (this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations"))?.n ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Webhooks & outbox
// ---------------------------------------------------------------------------

interface WebhookRow {
  id: number; kind: string; url: string; secret_cipher: string | null;
  enabled: number; events_json: string; created_at: string;
}

function rowToWebhook(r: WebhookRow): Webhook {
  return {
    id: r.id,
    kind: r.kind as Webhook["kind"],
    url: r.url,
    hasSecret: r.secret_cipher !== null,
    enabled: r.enabled === 1,
    events: JSON.parse(r.events_json) as EventName[],
    createdAt: r.created_at,
  };
}

export class WebhooksRepo {
  constructor(private readonly db: Db, private decryptSecret?: (cipher: string) => Promise<string>) {}

  list(): Webhook[] {
    return this.db.all<WebhookRow>("SELECT * FROM webhooks ORDER BY id").map(rowToWebhook);
  }

  byId(id: number): Webhook | undefined {
    const r = this.db.get<WebhookRow>("SELECT * FROM webhooks WHERE id = ?", id);
    return r ? rowToWebhook(r) : undefined;
  }

  create(kind: Webhook["kind"], url: string, events: EventName[], secretCipher: string | null): Webhook {
    const res = this.db.run(
      "INSERT INTO webhooks (kind, url, secret_cipher, enabled, events_json, created_at) VALUES (?, ?, ?, 1, ?, ?)",
      kind, url, secretCipher, JSON.stringify(events), iso()
    );
    return this.byId(Number(res.lastInsertRowid))!;
  }

  async secretOf(id: number): Promise<string | null> {
    const r = this.db.get<{ secret_cipher: string | null }>("SELECT secret_cipher FROM webhooks WHERE id = ?", id);
    if (!r?.secret_cipher || !this.decryptSecret) return null;
    return this.decryptSecret(r.secret_cipher);
  }

  update(id: number, patch: { url?: string; enabled?: boolean; events?: EventName[] }): Webhook | undefined {
    const w = this.byId(id);
    if (!w) return undefined;
    this.db.run(
      "UPDATE webhooks SET url = ?, enabled = ?, events_json = ? WHERE id = ?",
      patch.url ?? w.url, (patch.enabled ?? w.enabled) ? 1 : 0,
      JSON.stringify(patch.events ?? w.events), id
    );
    return this.byId(id);
  }

  delete(id: number): boolean {
    const res = this.db.run("DELETE FROM webhooks WHERE id = ?", id);
    return Number(res.changes) > 0;
  }

  enabledFor(event: EventName): Webhook[] {
    return this.list().filter((w) => w.enabled && w.events.includes(event));
  }

  watchIdsForWebhook(webhookId: number): number[] {
    return this.db.all<{ watch_id: number }>("SELECT watch_id FROM watch_webhooks WHERE webhook_id = ?", webhookId).map((r) => r.watch_id);
  }

  webhookIdsForWatch(watchId: number): number[] {
    return this.db.all<{ webhook_id: number }>("SELECT webhook_id FROM watch_webhooks WHERE watch_id = ?", watchId).map((r) => r.webhook_id);
  }

  setWatchWebhooks(watchId: number, webhookIds: number[]): void {
    this.db.run("DELETE FROM watch_webhooks WHERE watch_id = ?", watchId);
    for (const wid of webhookIds) {
      if (this.byId(wid)) this.db.run("INSERT OR IGNORE INTO watch_webhooks (watch_id, webhook_id) VALUES (?, ?)", watchId, wid);
    }
  }

  setWebhookWatches(webhookId: number, watchIds: number[]): void {
    this.db.run("DELETE FROM watch_webhooks WHERE webhook_id = ?", webhookId);
    for (const wid of watchIds) {
      this.db.run("INSERT OR IGNORE INTO watch_webhooks (watch_id, webhook_id) VALUES (?, ?)", wid, webhookId);
    }
  }

  enabledForWatch(event: EventName, watchId: number | null): Webhook[] {
    const all = this.enabledFor(event);
    if (watchId === null) return all.filter((w) => this.watchIdsForWebhook(w.id).length === 0);
    return all.filter((w) => {
      const ids = this.watchIdsForWebhook(w.id);
      return ids.length === 0 || ids.includes(watchId);
    });
  }

  enqueue(event: EventName, payload: Record<string, unknown>): number {
    const webhooks = this.enabledFor(event);
    let n = 0;
    for (const w of webhooks) {
      const res = this.db.run(
        `INSERT INTO webhook_deliveries (webhook_id, event, payload_json, status, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
        w.id, event, JSON.stringify(payload), iso(), iso()
      );
      if (Number(res.changes) > 0) n++;
    }
    return n;
  }

  enqueueForWatch(event: EventName, watchId: number, payload: Record<string, unknown>): number {
    const webhooks = this.enabledForWatch(event, watchId);
    let n = 0;
    for (const w of webhooks) {
      const res = this.db.run(
        `INSERT INTO webhook_deliveries (webhook_id, event, payload_json, status, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
        w.id, event, JSON.stringify({ ...payload, watchId }), iso(), iso()
      );
      if (Number(res.changes) > 0) n++;
    }
    if (n === 0 && watchId !== null) {
      // fallback global webhooks already handled, but if watch has no explicit links, global webhooks already included
    }
    return n;
  }

  dueDeliveries(limit = 10): Delivery[] {
    return this.db.all<Delivery>(
      `SELECT id, webhook_id AS webhookId, event, status, attempts, next_attempt_at AS nextAttemptAt,
              last_error AS lastError, created_at AS createdAt, delivered_at AS deliveredAt
       FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ? LIMIT ?`,
      iso(), limit
    );
  }

  deliveryPayload(id: number): { event: string; payload: Record<string, unknown>; url: string; kind: string } | undefined {
    const r = this.db.get<{ event: string; payload_json: string; url: string; kind: string }>(
      `SELECT d.event, d.payload_json, w.url, w.kind FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.id = ?`,
      id
    );
    return r ? { event: r.event, payload: JSON.parse(r.payload_json), url: r.url, kind: r.kind } : undefined;
  }

  markDelivery(id: number, status: Delivery["status"], attempts: number, nextAttemptAt: string | null, lastError: string | null): void {
    this.db.run(
      `UPDATE webhook_deliveries SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?,
         delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END WHERE id = ?`,
      status, attempts, nextAttemptAt, lastError, status, iso(), id
    );
  }

  deliveries(webhookId: number, limit = 50): Delivery[] {
    return this.db.all<Delivery>(
      `SELECT id, webhook_id AS webhookId, event, status, attempts, next_attempt_at AS nextAttemptAt,
              last_error AS lastError, created_at AS createdAt, delivered_at AS deliveredAt
       FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT ?`,
      webhookId, limit
    );
  }

  replay(id: number): boolean {
    const res = this.db.run(
      "UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = ? WHERE id = ? AND status IN ('failed','dead')",
      iso(), id
    );
    return Number(res.changes) > 0;
  }

  pendingCount(): number {
    return (this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status = 'pending'"))?.n ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Settings, secrets, events, audit
// ---------------------------------------------------------------------------

export class SettingsRepo {
  constructor(private readonly db: Db) {}
  get(key: string): string | null {
    return (this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key))?.value ?? null;
  }
  set(key: string, value: string): void {
    this.db.run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key, value
    );
  }
}

export class SecretsRepo {
  constructor(private readonly db: Db) {}
  set(name: string, ciphertextB64: string): void {
    this.db.run(
      "INSERT INTO secrets (name, ciphertext_b64, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET ciphertext_b64 = excluded.ciphertext_b64, updated_at = excluded.updated_at",
      name, ciphertextB64, iso()
    );
  }
  get(name: string): string | null {
    return (this.db.get<{ ciphertext_b64: string }>("SELECT ciphertext_b64 FROM secrets WHERE name = ?", name))?.ciphertext_b64 ?? null;
  }
  delete(name: string): void {
    this.db.run("DELETE FROM secrets WHERE name = ?", name);
  }
}

export class EventsRepo {
  constructor(private readonly db: Db) {}
  insert(type: string, payload: Record<string, unknown>): SseEvent {
    const now = iso();
    const res = this.db.run(
      "INSERT INTO events (type, payload_json, created_at) VALUES (?, ?, ?)",
      type, JSON.stringify(payload), now
    );
    return { id: Number(res.lastInsertRowid), type, payload, createdAt: now };
  }
  recent(limit = 50): SseEvent[] {
    return this.db.all<SseEvent>(
      "SELECT id, type, payload_json as payload, created_at AS createdAt FROM (SELECT id, type, payload_json, created_at FROM events ORDER BY id DESC LIMIT ?)",
      limit
    ).map((e) => ({ ...e, payload: JSON.parse(e.payload as unknown as string) }));
  }
}

export class AuditRepo {
  constructor(private readonly db: Db) {}
  insert(action: string, detail: Record<string, unknown> = {}): void {
    this.db.run("INSERT INTO audit_log (action, detail_json, created_at) VALUES (?, ?, ?)", action, JSON.stringify(detail), iso());
  }
  recent(limit = 100): Array<{ id: number; action: string; detail: Record<string, unknown>; createdAt: string }> {
    return this.db.all<{ id: number; action: string; detail_json: string; created_at: string }>(
      "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", limit
    ).map((r) => ({ id: r.id, action: r.action, detail: JSON.parse(r.detail_json), createdAt: r.created_at }));
  }
}

// ---------------------------------------------------------------------------
// Requêtes capturées (reverse Chrome DevTools)
// ---------------------------------------------------------------------------

export type CapturedKind = "inbox" | "send" | "api" | "other";

export interface CapturedRequest {
  id: number;
  method: string;
  url: string;
  host: string;
  path: string;
  status: number | null;
  requestHeaders: Record<string, string>;
  cookieNames: string[];
  postData: string | null;
  kind: CapturedKind;
  capturedAt: string;
}

/** Classe une requête capturée d'après méthode et chemin — heuristique large, jamais muette.
 *  ATTENTION : /realtime/typing, /read, /credentials sont du bruit temps réel
 *  (POST 200/204) — JAMAIS des envois. Seul un POST sur …/conversations/<id>/messages
 *  est un envoi. Mal classés, ils détournent le rejeu vers la mauvaise cible. */
export function classifyCaptured(method: string, path: string): CapturedKind {
  const p = path.toLowerCase();
  if (p.includes("/messaging") || p.includes("/conversation") || p.includes("/hal/")) {
    if (/\/realtime\/|\/typing|\/read\b|\/credentials/.test(p)) return "other";
    if (/\/conversations\/[^/]+\/messages/.test(p) && method === "POST") return "send";
    if (method === "POST" || method === "PUT" || method === "PATCH") return "send";
    return "inbox";
  }
  if (p.includes("/api/") || p.includes("/ajax/")) return "api";
  return "other";
}

export class CapturedRepo {
  constructor(private readonly db: Db) {}

  insert(req: {
    method: string; url: string; status: number | null;
    requestHeaders: Record<string, string>; cookieNames: string[];
    postData: string | null;
  }): void {
    const u = new URL(req.url);
    this.db.run(
      `INSERT INTO captured_requests (method, url, host, path, status, request_headers_json, cookie_names_json, post_data, kind, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      req.method, req.url, u.host, u.pathname + u.search, req.status,
      JSON.stringify(req.requestHeaders), JSON.stringify(req.cookieNames),
      req.postData ? req.postData.slice(0, 4096) : null,
      classifyCaptured(req.method, u.pathname),
      iso()
    );
  }

  list(limit = 200, kind?: CapturedKind): CapturedRequest[] {
    const rows = kind
      ? this.db.all<Record<string, unknown>>(
          "SELECT * FROM captured_requests WHERE kind = ? ORDER BY id DESC LIMIT ?", kind, limit
        )
      : this.db.all<Record<string, unknown>>(
          "SELECT * FROM captured_requests ORDER BY id DESC LIMIT ?", limit
        );
    return rows.map((r) => ({
      id: r.id as number,
      method: r.method as string,
      url: r.url as string,
      host: r.host as string,
      path: r.path as string,
      status: (r.status as number | null) ?? null,
      requestHeaders: JSON.parse(r.request_headers_json as string) as Record<string, string>,
      cookieNames: JSON.parse(r.cookie_names_json as string) as string[],
      postData: (r.post_data as string | null) ?? null,
      kind: r.kind as CapturedKind,
      capturedAt: r.captured_at as string,
    }));
  }

  /** Dernière requête capturée d'un type donné — base du rejeu exact. */
  latestOfKind(kind: CapturedKind, method?: string): CapturedRequest | undefined {
    const rows = this.list(50, kind).filter((r) => (method ? r.method === method : true));
    return rows[0];
  }
}

// ---------------------------------------------------------------------------
// Façade
// ---------------------------------------------------------------------------

export interface Repos {
  db: Db;
  listings: ListingsRepo;
  watches: WatchesRepo;
  jobs: JobsRepo;
  conversations: ConversationsRepo;
  webhooks: WebhooksRepo;
  settings: SettingsRepo;
  secrets: SecretsRepo;
  events: EventsRepo;
  audit: AuditRepo;
  captured: CapturedRepo;
}

export function createRepos(db: Db, decryptSecret?: (cipher: string) => Promise<string>): Repos {
  return {
    db,
    listings: new ListingsRepo(db),
    watches: new WatchesRepo(db),
    jobs: new JobsRepo(db),
    conversations: new ConversationsRepo(db),
    webhooks: new WebhooksRepo(db, decryptSecret),
    settings: new SettingsRepo(db),
    secrets: new SecretsRepo(db),
    events: new EventsRepo(db),
    audit: new AuditRepo(db),
    captured: new CapturedRepo(db),
  };
}
