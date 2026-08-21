import { describe, it, expect } from "vitest";
import { nextAttemptAt, RETRY_DELAYS_MS } from "../../apps/server/src/jobs/outbox.js";

describe("échelle de retry outbox", () => {
  const t0 = new Date("2026-08-21T12:00:00Z");

  it("+1 min, +5 min, +30 min, +2 h puis dead", () => {
    expect(RETRY_DELAYS_MS).toEqual([60_000, 300_000, 1_800_000, 7_200_000]);
    expect(nextAttemptAt(0, t0)?.toISOString()).toBe("2026-08-21T12:01:00.000Z");
    expect(nextAttemptAt(1, t0)?.toISOString()).toBe("2026-08-21T12:05:00.000Z");
    expect(nextAttemptAt(2, t0)?.toISOString()).toBe("2026-08-21T12:30:00.000Z");
    expect(nextAttemptAt(3, t0)?.toISOString()).toBe("2026-08-21T14:00:00.000Z");
    expect(nextAttemptAt(4, t0)).toBeNull();
  });

  it("au-delà de l'échelle → toujours dead", () => {
    expect(nextAttemptAt(99, t0)).toBeNull();
  });
});
