import type { Listing } from "@lbc/contracts";

/**
 * Anti-faux positifs déterministes (gratuits, toujours actifs sauf refus) :
 *  - prix ≤ 1 € : annonces fantômes / appâts / clics
 *  - échange, troc ou don dans le titre : pas des ventes
 *  - annonces de recherche (« cherche », « recherche », « achat »)
 *  - accessoires GPU évidents (waterblock, boîte vide, carton, backplate, ventilateur seul, câble, riser)
 *
 * NE filtre PAS le matériel défectueux / HS / pour pièces : une carte à
 * réparer est une opportunité, pas du bruit — c'est même souvent le meilleur
 * rapport prix/valeur pour qui sait réparer. La détection existe toujours
 * (`DEFECTIVE_PARTS_RE`, `defectReason()`) mais ne rejette rien par défaut ;
 * `LBC_FILTER_DEFECTIVE=1` réactive le rejet si l'avis change.
 */
const TRADING_RE = /(^|[^a-z0-9])(échange|echange|troc|don(?:née|s)?)([^a-z0-9]|$)/i;
const SEARCH_WANTED_RE = /(^|[^a-z0-9])(cherche|recherche|achat|achète|achete|wanted|recherchons|buy)([^a-z0-9]|$)/i;
const ACCESSORIES_RE = /(^|[^a-z0-9])(waterblock|water\s*block|water-block|waterforce\s*wb|\bwb\b|bloc\s*d'eau|watercooling|backplate|boite\s*vide|boîte\s*vide|carton\s*vide|carton\s*seul|boite\s*seule|boîte\s*seule|ventilateur\s*seul|ventilo\s*seul|fan\s*seul|riser|support\s*gpu|câble\s*riser|cable\s*riser|bracket|a\s*vendre\s*boite)([^a-z0-9]|$)/i;

// `d[eé]fectueuse?` ne couvrait QUE le feminin : il exige « defectueus » + un
// « e » optionnel, donc « defectueux » (masculin) passait au travers. Mesure du
// 04/09/2026 : l'annonce « [Défectueux] NVIDIA RTX 3080 10GB Founders Edition »
// a declenche un drop a 300 EUR. Les deux genres sont desormais couverts,
// ainsi que quelques formulations equivalentes sans ambiguite.
const DEFECTIVE_PARTS_RE = /(^|[^a-z0-9])(pour\s*pi[eè]ces?|pi[eè]ces?\s*d[eé]tach[eé]es?|pour\s*d[eé]pannage|pour\s*bricoleur|hs\b|hors\s*service|d[eé]fectueux|d[eé]fectueuses?|en\s*panne|ne\s*s['\s]*allume\s*(?:plus|pas)|ne\s*fonctionne\s*(?:plus|pas)|ne\s*marche\s*(?:plus|pas)|[àa]\s*r[eé]parer|non\s*fonctionnel|sans\s*disipateur|sans\s*dissipateur|sans\s*ventirad|sans\s*ventilateur|sans\s*cooler|art[eé]facts?|reballing|ecran\s*noir|écran\s*noir)([^a-z0-9]|$)/i;

/** Rejet du matériel défectueux : désactivé par défaut (voir en-tête). */
const FILTER_DEFECTIVE = process.env["LBC_FILTER_DEFECTIVE"] === "1";

/**
 * Motif de défaut détecté dans une annonce, ou null. Indépendant du filtrage :
 * sert à SIGNALER l'état sans écarter l'annonce (une carte HS bon marché reste
 * une affaire pour qui répare — encore faut-il le savoir avant d'acheter).
 */
export function defectReason(l: Pick<Listing, "title" | "body">): string | null {
  const title = l.title ?? "";
  if (DEFECTIVE_PARTS_RE.test(title)) return "défectueux / HS / pour pièces (titre)";
  if (l.body && DEFECTIVE_PARTS_RE.test(l.body)) return "défectueux / HS / pour pièces (description)";
  return null;
}

export function isJunkListing(l: Pick<Listing, "title" | "body" | "priceCents">): string | null {
  if (l.priceCents !== undefined && l.priceCents <= 100) return "prix ≤ 1 €";
  const title = l.title ?? "";
  if (TRADING_RE.test(title)) return "échange/troc/don (titre)";
  if (SEARCH_WANTED_RE.test(title)) return "annonce de recherche / achat";
  if (ACCESSORIES_RE.test(title)) return "accessoire (waterblock, boîte, ventilo...)";
  if (FILTER_DEFECTIVE) {
    const defect = defectReason(l);
    if (defect) return `matériel ${defect}`;
  }
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
