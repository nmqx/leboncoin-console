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

/**
 * Planificateur : toutes les cadenceMinutes + jitter [0, jitterMaxSeconds].
 * Chaque passage exécute les veilles actives une à une. Un job qui échoue est
 * mis en quarantaine avec diagnostic — jamais converti en liste vide.
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
  let nextRun: Date | null = null;
  let running = false;

  const schedule = () => {
    if (stopped) return;
    const jitterMs = Math.floor(Math.random() * cfg.scheduler.jitterMaxSeconds * 1000);
    const delayMs = cfg.scheduler.cadenceMinutes * 60_000 + jitterMs;
    nextRun = new Date(Date.now() + delayMs);
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
  };

  const runWatch = async (watchId: number, name: string, spec: Parameters<SearchEngine["run"]>[1]) => {
    const jobId = `job-${Date.now()}-${watchId}-${Math.floor(Math.random() * 1e4)}`;
    repos.jobs.create(jobId, watchId, spec, jobId);
    bus.publish("watch.started", { watchId, name, jobId, correlationId: jobId });
    try {
      if (repos.settings.get("kill_switch") === "1") {
        repos.jobs.finish(jobId, "quarantined", {
          error: { code: "kill_switch", message: "Kill switch actif — job suspendu", retryable: true },
        });
        repos.watches.markRun(watchId, "quarantined");
        return;
      }
      const result = await engine.run(jobId, spec, jobId);
      repos.jobs.finish(jobId, "completed", {
        pageCount: result.pageCount,
        itemsFound: result.found,
        itemsNew: result.newCount,
      });
      repos.watches.markRun(watchId, "completed");
      bus.publish("watch.completed", { watchId, name, jobId, ...result, correlationId: jobId });
      repos.webhooks.enqueue("watch.completed", { watchId, name, jobId, ...result });
    } catch (err) {
      const e = err as Error & { code?: string };
      repos.jobs.finish(jobId, "quarantined", {
        error: { code: e.code ?? "engine_error", message: e.message, retryable: true },
      });
      repos.watches.markRun(watchId, "quarantined");
      bus.publish("challenge.failed", {
        watchId,
        name,
        jobId,
        code: e.code ?? "engine_error",
        message: e.message,
        correlationId: jobId,
      });
      repos.webhooks.enqueue("challenge.failed", { watchId, name, code: e.code ?? "engine_error", message: e.message });
      logger.warn({ err: e.message, watchId }, "veille mise en quarantaine");
    }
  };

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const watches = repos.watches.list().filter((w) => w.enabled);
      for (const w of watches) {
        if (stopped) break;
        await runWatch(w.id, w.name, w.spec);
      }
      // messagerie : sync inbox + réponses automatiques (jamais si kill switch)
      if (onTick && repos.settings.get("kill_switch") !== "1") {
        try {
          await onTick();
        } catch (err) {
          logger.warn({ err: (err as Error).message }, "tick messagerie échoué");
        }
      }
    } finally {
      running = false;
      schedule();
    }
  };

  void tick(); // premier passage immédiat au démarrage

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      nextRun = null;
    },
    nextRunAt: () => nextRun,
    runNow: async () => {
      if (running) return;
      if (timer) clearTimeout(timer);
      await tick();
    },
  };
}
