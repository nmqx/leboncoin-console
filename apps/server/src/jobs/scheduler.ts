import type { Bus } from "../bus.js";
import type { Repos } from "../repos.js";
import type { SearchEngine } from "../adapters/leboncoin/engine.js";
import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";

export interface SchedulerHandle {
  stop(): void;
  nextRunAt(): Date | null;
  runNow(): Promise<void>;
}

/** Granularité du réveil : une veille part au plus tard TICK_MS après son échéance. */
const TICK_MS = 15_000;
/** Plafond dur par job de veille : un moteur bloqué ne doit pas arrêter la file. */
const WATCH_TIMEOUT_MS = 180_000;
/** Plafond dur du passage messagerie : un sync bloqué ne doit pas geler le planificateur. */
const MESSAGING_TIMEOUT_MS = 120_000;
/** Une seule veille démarre par créneau afin de ne jamais former de rafale. */
export const DEFAULT_WATCH_START_GAP_MS = 300_000;
/** Jitter ajouté au créneau pour éviter une périodicité robotique parfaite. */
export const DEFAULT_WATCH_START_JITTER_MS = 120_000;
const configuredWatchGap = Number(process.env["LBC_WATCH_START_GAP_MS"] ?? DEFAULT_WATCH_START_GAP_MS);
export const WATCH_START_GAP_MS = Number.isFinite(configuredWatchGap)
  ? Math.max(60_000, configuredWatchGap)
  : DEFAULT_WATCH_START_GAP_MS;
const configuredWatchJitter = Number(process.env["LBC_WATCH_START_JITTER_MS"] ?? DEFAULT_WATCH_START_JITTER_MS);
export const WATCH_START_JITTER_MS = Number.isFinite(configuredWatchJitter)
  ? Math.max(0, configuredWatchJitter)
  : DEFAULT_WATCH_START_JITTER_MS;
/** Une même panne externe ne doit produire qu'une alerte toutes les six heures. */
const INCIDENT_ALERT_INTERVAL_MS = 6 * 60 * 60_000;
const SHARED_FAILURE_CODES = new Set([
  "lbc_upstream_unavailable",
  "lbc_schema_changed",
  "datadome_rotate_ip",
  "datadome_no_solver",
  "datadome_attempts_exhausted",
  "datadome_replay_failed",
]);

export function sharedFailureBackoffMs(code: string, streak: number): number {
  const baseMinutes = code === "lbc_schema_changed"
    ? 60
    : code === "lbc_upstream_unavailable" ? 15 : 5;
  return Math.min(60, baseMinutes * 2 ** Math.max(0, streak - 1)) * 60_000;
}

export function nextWatchDelayMs(random = Math.random): number {
  return WATCH_START_GAP_MS + Math.floor(random() * WATCH_START_JITTER_MS);
}

/** Sélection équitable de la prochaine veille arrivée à échéance. */
export function nextDueWatchIndex(
  watches: ReadonlyArray<{ id: number }>,
  nextDue: ReadonlyMap<number, number>,
  cursor: number,
  now: number
): number | null {
  for (let step = 0; step < watches.length; step++) {
    const index = (cursor + step) % watches.length;
    if ((nextDue.get(watches[index]!.id) ?? 0) <= now) return index;
  }
  return null;
}

/**
 * Rejette si la promesse n'est pas réglée dans le délai. Un appel réseau qui
 * ne répond jamais sinon figerait `running` à true pour toujours.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} : timeout ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * Planificateur par veille : chacune respecte SA cadenceMinutes + jitter
 * [0, jitterMaxSeconds]. Un job qui échoue est mis en quarantaine avec
 * diagnostic — jamais converti en liste vide. La messagerie (sync + réponses
 * auto) garde la cadence globale historique.
 */
export function startScheduler(
  cfg: AppConfig,
  repos: Repos,
  engine: SearchEngine,
  bus: Bus,
  onTick?: () => Promise<void>
): SchedulerHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  /** Prochaine échéance par veille (epoch ms). Absente = due immédiatement. */
  const nextDue = new Map<number, number>();
  const incidentAlertedAt = new Map<string, number>();
  let sharedFailureStreak = 0;
  let nextWatchStartAt = Date.now();
  let watchCursor = 0;
  let messagingDue = Date.now(); // premier passage immédiat au démarrage

  const jitterMs = () => Math.floor(Math.random() * cfg.scheduler.jitterMaxSeconds * 1000);

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), TICK_MS);
  };

  const runWatch = async (
    watchId: number,
    name: string,
    spec: Parameters<SearchEngine["run"]>[1]
  ): Promise<{ ok: boolean; code?: string; message?: string }> => {
    const jobId = `job-${Date.now()}-${watchId}-${Math.floor(Math.random() * 1e4)}`;
    repos.jobs.create(jobId, watchId, spec, jobId);
    bus.publish("watch.started", { watchId, name, jobId, correlationId: jobId });
    try {
      if (repos.settings.get("kill_switch") === "1") {
        repos.jobs.finish(jobId, "quarantined", {
          error: { code: "kill_switch", message: "Kill switch actif — job suspendu", retryable: true },
        });
        repos.watches.markRun(watchId, "quarantined");
        return { ok: false, code: "kill_switch" };
      }
      const result = await withTimeout(engine.run(jobId, spec, jobId, watchId), WATCH_TIMEOUT_MS, `veille ${watchId}`);
      repos.watches.linkListings(watchId, result.listingIds);
      repos.jobs.finish(jobId, "completed", {
        pageCount: result.pageCount,
        itemsFound: result.found,
        itemsNew: result.newCount,
      });
      repos.watches.markRun(watchId, "completed");
      bus.publish("watch.completed", { watchId, name, jobId, ...result, correlationId: jobId });
      repos.webhooks.enqueueForWatch("watch.completed", watchId, { watchId, name, jobId, ...result });
      return { ok: true };
    } catch (err) {
      const e = err as Error & { code?: string };
      const code = e.code ?? "engine_error";
      repos.jobs.finish(jobId, "quarantined", {
        error: { code, message: e.message, retryable: true },
      });
      repos.watches.markRun(watchId, "quarantined");
      bus.publish("challenge.failed", {
        watchId,
        name,
        jobId,
        code,
        message: e.message,
        correlationId: jobId,
      });
      // Une panne LBC partagée est souvent transitoire. Elle n'alerte qu'après
      // trois cycles échoués, dans tick(), afin d'éviter le bruit Discord.
      if (!SHARED_FAILURE_CODES.has(code)) {
        const now = Date.now();
        const lastAlert = incidentAlertedAt.get(code) ?? 0;
        if (now - lastAlert >= INCIDENT_ALERT_INTERVAL_MS) {
          repos.webhooks.enqueueForWatch("challenge.failed", watchId, { watchId, name, code, message: e.message });
          incidentAlertedAt.set(code, now);
        } else {
          logger.info({ code, watchId }, "alerte incident identique supprimée");
        }
      }
      logger.warn({ err: e.message, watchId }, "veille mise en quarantaine");
      return { ok: false, code, message: e.message };
    }
  };

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const watches = repos.watches.list().filter((w) => w.enabled);
      const alive = new Set(watches.map((w) => w.id));
      for (const id of [...nextDue.keys()]) {
        if (!alive.has(id)) nextDue.delete(id); // veille supprimée/désactivée
      }
      // Tourniquet équitable : au plus une veille toutes les cinq minutes.
      // Avec quatre veilles, chacune repasse environ toutes les vingt minutes.
      if (watches.length > 0 && Date.now() >= nextWatchStartAt) {
        const dueIndex = nextDueWatchIndex(watches, nextDue, watchCursor, Date.now());
        if (dueIndex !== null && !stopped) {
          const w = watches[dueIndex]!;
          watchCursor = (dueIndex + 1) % watches.length;
          nextWatchStartAt = Date.now() + nextWatchDelayMs();
          const outcome = await runWatch(w.id, w.name, w.spec);
          nextDue.set(w.id, Date.now() + w.cadenceMinutes * 60_000 + jitterMs());
          if (outcome.ok) {
            sharedFailureStreak = 0;
          } else if (outcome.code && SHARED_FAILURE_CODES.has(outcome.code)) {
            sharedFailureStreak++;
            const delayMs = sharedFailureBackoffMs(outcome.code, sharedFailureStreak);
            const retryAt = Date.now() + delayMs + jitterMs();
            for (const watch of watches) nextDue.set(watch.id, retryAt);
            if (sharedFailureStreak >= 3) {
              const lastAlert = incidentAlertedAt.get(outcome.code) ?? 0;
              if (Date.now() - lastAlert >= INCIDENT_ALERT_INTERVAL_MS) {
                repos.webhooks.enqueueForWatch("challenge.failed", w.id, {
                  watchId: w.id,
                  name: w.name,
                  code: outcome.code,
                  message: outcome.message ?? "Panne Leboncoin persistante",
                  streak: sharedFailureStreak,
                });
                incidentAlertedAt.set(outcome.code, Date.now());
              }
            }
            logger.warn(
              { code: outcome.code, streak: sharedFailureStreak, retryAt: new Date(retryAt).toISOString() },
              "panne LBC partagée — toutes les veilles passent en backoff"
            );
          }
        }
      }
      // messagerie : sync inbox + réponses automatiques — sa propre horloge,
      // avancée même si l'exécution est sautée (kill switch) pour ne pas
      // laisser un compte à rebours collé au passé. Plafond dur : un sync
      // bloqué ne doit jamais geler la boucle.
      if (onTick && !stopped && messagingDue <= Date.now()) {
        messagingDue = Date.now() + cfg.scheduler.cadenceMinutes * 60_000 + jitterMs();
        if (repos.settings.get("kill_switch") !== "1") {
          try {
            await withTimeout(onTick(), MESSAGING_TIMEOUT_MS, "messagerie");
          } catch (err) {
            logger.warn({ err: (err as Error).message }, "tick messagerie échoué");
          }
        }
      }
    } finally {
      running = false;
      scheduleNext();
    }
  };

  // Premier passage immédiat : sans cet appel, aucun timer n'est armé (le
  // setTimeout ne vit que dans le finally de tick) et le planificateur
  // reste idle pour toujours — veilles créées jamais exécutées.
  void tick();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      nextDue.clear();
    },
    nextRunAt: () => {
      const watchDue = Math.min(...nextDue.values());
      const soonestWatch = Number.isFinite(watchDue) ? Math.max(watchDue, nextWatchStartAt) : Number.POSITIVE_INFINITY;
      const soonest = Math.min(soonestWatch, messagingDue);
      return Number.isFinite(soonest) ? new Date(soonest) : null;
    },
    runNow: async () => {
      if (running) return;
      for (const id of nextDue.keys()) nextDue.set(id, 0);
      nextWatchStartAt = 0;
      messagingDue = 0;
      if (timer) clearTimeout(timer);
      await tick();
    },
  };
}
