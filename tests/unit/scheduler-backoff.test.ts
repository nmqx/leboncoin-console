import { describe, expect, it } from "vitest";
import { sharedFailureBackoffMs } from "../../apps/server/src/jobs/scheduler.js";

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
