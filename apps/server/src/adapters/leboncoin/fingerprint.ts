import { getEmulationHeaders } from "wreq-js";

/**
 * Empreinte TLS/HTTP2 stable pour Leboncoin.
 *
 * L'ancienne rotation faisait alterner Chrome, Firefox, Edge et Safari depuis
 * la même IP. C'est une identité impossible pour un visiteur et un signal
 * DataDome plus fort que le simple volume. On conserve donc le profil Chrome
 * le plus récent réellement fourni par wreq-js, avec son OS et son User-Agent.
 */
export interface Fingerprint {
  browser: string;
  os: "windows" | "macos" | "linux" | "android" | "ios";
}

/** À remonter seulement quand wreq-js publie une empreinte Chrome plus récente. */
export const FINGERPRINT_POOL: readonly Fingerprint[] = [
  { browser: "chrome_149", os: "windows" },
];

/**
 * Retourne toujours la même empreinte. `exclude` reste accepté pour préserver
 * l'API du transport, mais une rotation silencieuse est bannie.
 */
export function pickFingerprint(_exclude: readonly Fingerprint[] = []): Fingerprint {
  return FINGERPRINT_POOL[0]!;
}

/** UA issu de la même source que JA4, HTTP/2 et sec-ch-ua. */
export function userAgentFor(fp: Fingerprint): string {
  const headers = getEmulationHeaders(fp.browser as never, fp.os as never);
  return headers.get("user-agent") ?? "";
}

/** Âge du profil le plus récent par rapport à la version Chrome courante. */
export function poolStaleness(latestChromeMajor: number): number {
  const majors = FINGERPRINT_POOL.map((fp) => Number(fp.browser.match(/_(\d+)/)?.[1] ?? 0)).filter(
    (n) => n > 0
  );
  return latestChromeMajor - Math.max(...majors, 0);
}
