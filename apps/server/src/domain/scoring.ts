import type { Listing, PricePoint, SearchSpec } from "@lbc/contracts";

// ---------------------------------------------------------------------------
// Tokenisation FR — accent-fold, stopwords minimes
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "les", "des", "une", "aux", "avec", "pour", "dans", "sur", "est", "sont",
  "pas", "mais", "que", "qui", "quoi", "vends", "vend", "occasion", "tres",
]);

export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function tokenize(s: string): string[] {
  return fold(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

// ---------------------------------------------------------------------------
// Score de pertinence — transparent, pondéré
//   titre ×3, catégorie ×2, corps ×1
//   score = Σ pondérations atteintes / (nbTokens × 3), borné [0, 1]
// ---------------------------------------------------------------------------

export function relevanceScore(query: string, listing: Pick<Listing, "title" | "body" | "category">): number {
  const tokens = tokenize(query);
  if (tokens.length === 0) return 0;
  const title = new Set(tokenize(listing.title));
  const body = new Set(tokenize(listing.body ?? ""));
  const category = new Set(tokenize(listing.category ?? ""));
  let hit = 0;
  for (const t of tokens) {
    if (title.has(t)) hit += 3;
    else if (category.has(t)) hit += 2;
    else if (body.has(t)) hit += 1;
  }
  return Math.min(1, hit / (tokens.length * 3));
}

// ---------------------------------------------------------------------------
// Médiane & bonne affaire
//   dealScore = (médiane − prix) / médiane, borné [-1, 1]
// ---------------------------------------------------------------------------

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function dealScore(price: number, peerPrices: number[]): number | undefined {
  const med = median(peerPrices);
  if (med === null || med === 0) return undefined;
  return Math.max(-1, Math.min(1, (med - price) / med));
}

// ---------------------------------------------------------------------------
// Tri local — prix, date, pertinence, distance ; null toujours en dernier
// ---------------------------------------------------------------------------

type Sortable = Pick<Listing, "id" | "priceCents" | "publishedAt" | "score" | "attributes">;

export function localSort(items: Sortable[], sort: NonNullable<SearchSpec["localSort"]>): Sortable[] {
  const out = [...items];
  for (const rule of [...sort].reverse()) {
    const dir = rule.direction === "asc" ? 1 : -1;
    out.sort((a, b) => {
      const av = sortValue(a, rule.field);
      const bv = sortValue(b, rule.field);
      if (av === null && bv === null) return 0;
      if (av === null) return 1; // null en dernier quelle que soit la direction
      if (bv === null) return -1;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }
  return out;
}

function sortValue(l: Sortable, field: string): number | null {
  switch (field) {
    case "price":
      return l.priceCents ?? null;
    case "publishedAt":
      return l.publishedAt ? Date.parse(l.publishedAt) : null;
    case "relevance":
      return l.score;
    case "distance": {
      const d = l.attributes["distanceKm"];
      return typeof d === "number" ? d : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Déduplication et fusion par ID
// ---------------------------------------------------------------------------

export interface UpsertOutcome {
  listing: Listing;
  isNew: boolean;
  priceChanged: boolean;
  previousPriceCents: number | null;
}

/**
 * Fusionne une annonce entrante sur un lot existant :
 *   - ID identique → on garde l'occurrence la plus récente (scrapedAt),
 *     images union, attributs fusionnés ;
 *   - prix différent → historique à retenir côté appelant.
 */
export function dedupe(existing: Listing[], incoming: Listing[]): UpsertOutcome[] {
  const byId = new Map(existing.map((l) => [l.id, l]));
  const outcomes: UpsertOutcome[] = [];
  for (const inc of incoming) {
    const prev = byId.get(inc.id);
    if (!prev) {
      byId.set(inc.id, inc);
      outcomes.push({ listing: inc, isNew: true, priceChanged: false, previousPriceCents: null });
      continue;
    }
    const latest = (Date.parse(inc.scrapedAt) || 0) >= (Date.parse(prev.scrapedAt) || 0) ? inc : prev;
    const merged: Listing = {
      ...latest,
      images: [...new Set([...prev.images, ...inc.images])],
      attributes: { ...prev.attributes, ...inc.attributes },
    };
    const priceChanged =
      prev.priceCents !== undefined && inc.priceCents !== undefined && prev.priceCents !== inc.priceCents;
    byId.set(merged.id, merged);
    outcomes.push({
      listing: merged,
      isNew: false,
      priceChanged,
      previousPriceCents: priceChanged ? prev.priceCents ?? null : null,
    });
  }
  return outcomes;
}

export function priceHistoryOf(points: PricePoint[]): PricePoint[] {
  return [...points].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
}
