import { afterEach, describe, expect, it, vi } from "vitest";
import { startScheduler } from "../../apps/server/src/jobs/scheduler.js";
import { loadConfig } from "../../apps/server/src/config.js";
import { Db } from "../../apps/server/src/db.js";
import { createRepos } from "../../apps/server/src/repos.js";
import { Bus } from "../../apps/server/src/bus.js";

afterEach(() => vi.useRealTimers());

describe("scheduler réel avec horloge simulée", () => {
  it("respecte les cinq minutes après un échec et un redémarrage, et ne crée aucun job pendant la pause", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));
    const db = Db.inMemory();
    const repos = createRepos(db);
    const cfg = loadConfig({ ...process.env, LBC_MODE: "fixtures" });
    const run = vi.fn().mockRejectedValue(Object.assign(new Error("blocked"), { code: "datadome_rotate_ip" }));
    const engine = { kind: "live" as const, run };
    const bus = new Bus(repos.events);
    let scheduler: ReturnType<typeof startScheduler> | undefined;
    try {
      repos.watches.create("GPU", { query: "rtx 3090", maxItems: 10 }, 5);
      repos.settings.set("kill_switch", "1");
      scheduler = startScheduler(cfg, repos, engine, bus);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(run).not.toHaveBeenCalled();
      expect(repos.jobs.recent()).toHaveLength(0);
      expect(scheduler.nextRunAt()).toBeNull();
      repos.settings.set("kill_switch", "0");
      await vi.advanceTimersByTimeAsync(15_000);
      expect(run).toHaveBeenCalledTimes(1);
      expect(Number(repos.settings.get("lbc_next_watch_start_at"))).toBe(Date.now() + 300_000);
      scheduler.stop();
      scheduler = startScheduler(cfg, repos, engine, bus);
      expect(scheduler.nextRunAt()?.getTime()).toBe(Date.now() + 300_000);
      await vi.advanceTimersByTimeAsync(299_999);
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(2);
    } finally { scheduler?.stop(); db.raw.close(); }
  });
});
