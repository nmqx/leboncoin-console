import { logger } from "../../logger.js";

/**
 * Cadenceur global des appels leboncoin.fr.
 *
 * Le débit n'est pas décidé par la veille qui appelle mais par le processus :
 * 4 veilles à 3 min qui paginent chacune de leur côté formaient des rafales
 * (plusieurs requêtes dans la même seconde) — c'est le motif que DataDome lit,
 * bien avant l'empreinte TLS. Toutes les requêtes LBC passent ici, sont
 * sérialisées, et séparées d'au moins MIN_GAP_MS + un jitter aléatoire.
 *
 * Réglable sans rebuild : LBC_MIN_GAP_MS / LBC_GAP_JITTER_MS.
 * Défauts : 9 s + [0, 6) s ⇒ ~12 s d'écart moyen, soit ~15 requêtes par
 * fenêtre de 3 min — au-dessus du besoin réel (4 veilles × 1-4 pages).
 */
const MIN_GAP_MS = Number(process.env["LBC_MIN_GAP_MS"] ?? 9_000);
const GAP_JITTER_MS = Number(process.env["LBC_GAP_JITTER_MS"] ?? 6_000);

let chain: Promise<void> = Promise.resolve();
let lastAt = 0;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Exécute `fn` en respectant l'écart minimal depuis la requête LBC précédente,
 * toutes veilles confondues. Sérialisé : deux appels concurrents s'attendent
 * au lieu de partir ensemble.
 */
export function paced<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const target = lastAt + MIN_GAP_MS + Math.floor(Math.random() * GAP_JITTER_MS);
    const waitMs = target - Date.now();
    if (waitMs > 0) {
      logger.debug({ label, waitMs }, "cadenceur LBC : attente");
      await sleep(waitMs);
    }
    lastAt = Date.now();
  });
  // La chaîne ne porte que l'attente : une requête qui échoue ne doit pas
  // casser le cadenceur pour les suivantes.
  chain = run.catch(() => undefined);
  return run.then(fn);
}

/** Écart minimal effectif (pour les diagnostics et les tests). */
export function pacerSettings(): { minGapMs: number; jitterMs: number } {
  return { minGapMs: MIN_GAP_MS, jitterMs: GAP_JITTER_MS };
}

/** Remise à zéro — tests uniquement. */
export function resetPacer(): void {
  lastAt = 0;
  chain = Promise.resolve();
}
