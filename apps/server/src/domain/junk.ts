import type { Listing } from "@lbc/contracts";

/**
 * Anti-faux positifs déterministes (gratuits, toujours actifs sauf refus) :
 *  - prix ≤ 1 € : annonces fantômes / appâts / clics
 *  - échange, troc ou don dans le titre : pas des ventes
 *  - annonces de recherche (« cherche », « recherche », « achat »)
 *  - accessoires GPU évidents (waterblock, boîte vide, carton, backplate, ventilateur seul, câble, riser)
 *  - matériel défectueux / pour pièces / HS / incomplet (sans dissipateur, sans ventilateur, artefacts, etc.)
 */
const TRADING_RE = /(^|[^a-z0-9])(échange|echange|troc|don(?:née|s)?)([^a-z0-9]|$)/i;
const SEARCH_WANTED_RE = /(^|[^a-z0-9])(cherche|recherche|achat|achète|achete|wanted|recherchons|buy)([^a-z0-9]|$)/i;
const ACCESSORIES_RE = /(^|[^a-z0-9])(waterblock|water\s*block|water-block|waterforce\s*wb|\bwb\b|bloc\s*d'eau|watercooling|backplate|boite\s*vide|boîte\s*vide|carton\s*vide|carton\s*seul|boite\s*seule|boîte\s*seule|ventilateur\s*seul|ventilo\s*seul|fan\s*seul|riser|support\s*gpu|câble\s*riser|cable\s*riser|bracket|a\s*vendre\s*boite)([^a-z0-9]|$)/i;

const DEFECTIVE_PARTS_RE = /(^|[^a-z0-9])(pour\s*pi[eè]ces?|pi[eè]ces?\s*d[eé]tach[eé]es?|pour\s*d[eé]pannage|pour\s*bricoleur|hs\b|hors\s*service|d[eé]fectueuse?|en\s*panne|ne\s*s['\s]*allume\s*(?:plus|pas)|non\s*fonctionnel|sans\s*disipateur|sans\s*dissipateur|sans\s*ventirad|sans\s*ventilateur|sans\s*cooler|art[eé]facts?|reballing|ecran\s*noir|écran\s*noir)([^a-z0-9]|$)/i;

export function isJunkListing(l: Pick<Listing, "title" | "body" | "priceCents">): string | null {
  if (l.priceCents !== undefined && l.priceCents <= 100) return "prix ≤ 1 €";
  const title = l.title ?? "";
  if (TRADING_RE.test(title)) return "échange/troc/don (titre)";
  if (SEARCH_WANTED_RE.test(title)) return "annonce de recherche / achat";
  if (ACCESSORIES_RE.test(title)) return "accessoire (waterblock, boîte, ventilo...)";
  if (DEFECTIVE_PARTS_RE.test(title)) return "matériel HS / défectueux / pour pièces";
  if (l.body && DEFECTIVE_PARTS_RE.test(l.body)) return "matériel HS / défectueux / pour pièces (description)";
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
