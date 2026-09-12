import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveEngine } from "../../apps/server/src/adapters/leboncoin/live.js";
import { WreqTransport } from "../../apps/server/src/adapters/leboncoin/wreq-transport.js";
import { Db } from "../../apps/server/src/db.js";
import { createRepos } from "../../apps/server/src/repos.js";
import { Bus } from "../../apps/server/src/bus.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("recherche HTTP sans rafale", () => {
  it("un blocage fait un seul appel, aucun solveur, puis change de profil au cycle suivant", async () => {
    const db = Db.inMemory();
    try {
      const repos = createRepos(db);
      const profiles: string[] = [];
      const request = vi.spyOn(WreqTransport.prototype, "request").mockImplementation(async function () {
        profiles.push(`${this.profile.browser}/${this.profile.os}`);
        return { status: 403, headers: {}, body: '{"url":"https://geo.captcha-delivery.com/captcha/?t=bv"}' };
      });
      const key = vi.fn(async () => "unused-paid-key");
      vi.stubEnv("LBC_ALLOW_PAID_SOLVER", "0");
      const engine = new LiveEngine({ repos, bus: new Bus(repos.events), getProxy: async () => null, getAnysolverKey: key });
      for (const id of ["first", "second"]) {
        await expect(engine.run(id, { query: "rtx 3090", maxItems: 10 }, id)).rejects.toMatchObject({ code: "datadome_rotate_ip" });
      }
      expect(request).toHaveBeenCalledTimes(2);
      expect(key).not.toHaveBeenCalled();
      expect(profiles[0]).not.toBe(profiles[1]);
      expect(repos.listings.count()).toBe(0);
    } finally { db.raw.close(); }
  });
});
