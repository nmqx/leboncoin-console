import { getEmulationHeaders } from "wreq-js";

/**
 * Rotation d'empreintes TLS/HTTP2 pour Leboncoin.
 *
 * Mesuré le 04/09/2026 en direct depuis le serveur (aucun proxy, aucune
 * session, aucun solveur) :
 *   - `chrome_131` figé (l'ancienne valeur en dur du transport) : 4/4 → 403
 *     DataDome, page de blocage de 774 octets. Un Chrome 131 en septembre 2026
 *     a ~2 ans de retard : l'empreinte JA4 + l'UA sont un signal à eux seuls.
 *   - pool ci-dessous, une empreinte différente par requête : 9/9 → 200 avec
 *     `__NEXT_DATA__` complet (35 annonces, ~1,15 Mo, p50 ≈ 250 ms).
 *
 * Règle : ne JAMAIS coder un User-Agent en dur. L'UA, les `sec-ch-ua` et
 * l'ordre des en-têtes viennent du profil lui-même (`getEmulationHeaders`) —
 * un UA qui ne correspond pas au profil TLS est justement ce que DataDome
 * cherche. Le pool ne contient que des versions encore en support (N-4 max) :
 * il doit être remonté quand les navigateurs avancent (voir `assertFresh`).
 */
export interface Fingerprint {
  browser: string;
  os: "windows" | "macos" | "linux" | "android" | "ios";
}

/** Empreintes validées en live le 04/09/2026 (9/9 → 200 en direct). */
export const FINGERPRINT_POOL: readonly Fingerprint[] = [
  { browser: "chrome_149", os: "windows" },
  { browser: "chrome_148", os: "windows" },
  { browser: "chrome_147", os: "macos" },
  { browser: "chrome_146", os: "windows" },
  { browser: "chrome_145", os: "linux" },
  { browser: "firefox_151", os: "windows" },
  { browser: "firefox_150", os: "macos" },
  { browser: "edge_148", os: "windows" },
  { browser: "safari_26.4", os: "macos" },
];

/** Un profil différent par créneau de cinq minutes, même après redémarrage. */
export const FINGERPRINT_SLOT_MS = 5 * 60_000;

function keyOf(fp: Fingerprint): string {
  return `${fp.browser}/${fp.os}`;
}

/**
 * La rotation dépend du temps plutôt que de la mémoire du processus. Un
 * redémarrage ne remet donc pas systématiquement le pool sur Chrome 149.
 * `exclude` permet à un rejeu explicite de prendre le profil suivant.
 */
export function pickFingerprint(exclude: readonly Fingerprint[] = [], now = Date.now()): Fingerprint {
  const banned = new Set(exclude.map(keyOf));
  const start = Math.floor(now / FINGERPRINT_SLOT_MS) % FINGERPRINT_POOL.length;
  for (let offset = 0; offset < FINGERPRINT_POOL.length; offset++) {
    const fp = FINGERPRINT_POOL[(start + offset) % FINGERPRINT_POOL.length]!;
    if (!banned.has(keyOf(fp))) return fp;
  }
  return FINGERPRINT_POOL[start]!;
}

/**
 * User-Agent réel du profil. Source unique de vérité : jamais de constante,
 * jamais l'UA d'une session importée sur un profil TLS différent.
 */
export function userAgentFor(fp: Fingerprint): string {
  const headers = getEmulationHeaders(fp.browser as never, fp.os as never);
  return headers.get("user-agent") ?? "";
}

/**
 * Garde-fou anti-pourrissement : si le pool date (les profils vieillissent au
 * rythme des sorties Chrome), on veut le savoir dans les logs avant que
 * DataDome ne le dise en 403. Retourne l'âge en versions Chrome majeures du
 * profil Chrome le plus récent du pool comparé à `latest`.
 */
export function poolStaleness(latestChromeMajor: number): number {
  const majors = FINGERPRINT_POOL.map((fp) => Number(fp.browser.match(/_(\d+)/)?.[1] ?? 0)).filter(
    (n) => n > 0
  );
  return latestChromeMajor - Math.max(...majors, 0);
}
