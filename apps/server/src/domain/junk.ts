import type { Listing } from "@lbc/contracts";

/**
 * Anti-faux positifs déterministes (gratuits, toujours actifs sauf refus) :
 *  - prix ≤ 1 € : annonces fantômes / appâts / clics
 *  - échange, troc ou don dans le titre : pas des ventes
 * L'anti-faux positifs sémantique (Just Dance ≠ console Switch) passe par
 * filterByRelevance côté LLM — ces règles ne couvrent que le mécanique.
 */
const TRADING_RE = /(^|[^a-z])(échange|echange|troc|don(?:née|s)?)([^a-z]|$)/i;

export function isJunkListing(l: Pick<Listing, "title" | "body" | "priceCents">): string | null {
  if (l.priceCents !== undefined && l.priceCents <= 100) return "prix ≤ 1 €";
  // titre seulement : « don »/« échange » dans les descriptions légales est fréquent
  if (TRADING_RE.test(l.title ?? "")) return "échange/troc/don (titre)";
  return null;
}

export function filterJunk<T extends Pick<Listing, "title" | "body" | "priceCents">>(items: T[]): { kept: T[]; junked: Array<{ item: T; reason: string }> } {
  const kept: T[] = [];
  const junked: Array<{ item: T; reason: string }> = [];
  for (const item of items) {
    const reason = isJunkListing(item);
    if (reason) junked.push({ item, reason });
    else kept.push(item);
  }
  return { kept, junked };
}
