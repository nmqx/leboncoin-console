import { describe, expect, it } from "vitest";
import {
  DEFAULT_WATCH_START_GAP_MS,
  WATCH_START_GAP_MS,
  nextDueWatchIndex,
  sharedFailureBackoffMs,
} from "../../apps/server/src/jobs/scheduler.js";

describe("backoff partagé Leboncoin", () => {
  it("augmente sur les indisponibilités et plafonne à une heure", () => {
    expect(sharedFailureBackoffMs("lbc_upstream_unavailable", 1)).toBe(5 * 60_000);
    expect(sharedFailureBackoffMs("lbc_upstream_unavailable", 3)).toBe(20 * 60_000);
    expect(sharedFailureBackoffMs("lbc_upstream_unavailable", 20)).toBe(60 * 60_000);
  });

  it("laisse davantage refroidir DataDome et les changements de schéma", () => {
    expect(sharedFailureBackoffMs("datadome_rotate_ip", 1)).toBe(15 * 60_000);
    expect(sharedFailureBackoffMs("lbc_schema_changed", 1)).toBe(60 * 60_000);
  });
});

describe("cadencement global des veilles", () => {
  it("utilise un créneau de cinq minutes par défaut", () => {
    expect(DEFAULT_WATCH_START_GAP_MS).toBe(5 * 60_000);
    expect(WATCH_START_GAP_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("fait tourner équitablement les veilles arrivées à échéance", () => {
    const watches = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    const due = new Map(watches.map((watch) => [watch.id, 0]));
    expect(nextDueWatchIndex(watches, due, 0, 100)).toBe(0);
    expect(nextDueWatchIndex(watches, due, 1, 100)).toBe(1);
    expect(nextDueWatchIndex(watches, due, 3, 100)).toBe(3);
  });

  it("saute une veille qui n'est pas encore due", () => {
    const watches = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const due = new Map([[1, 500], [2, 0], [3, 0]]);
    expect(nextDueWatchIndex(watches, due, 0, 100)).toBe(1);
  });
});
