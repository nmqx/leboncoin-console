import { describe, it, expect } from "vitest";
import { decodeLuat } from "../../apps/server/src/adapters/chrome/token-refresh.js";

function jwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(payload)}.signature`;
}

describe("decodeLuat — claims du bearer Leboncoin", () => {
  it("extrait userId (sub lbc;<uuid>;<storeId>) et exp", () => {
    const luat = jwt({ sub: "lbc;11111111-2222-3333-4444-555555555555;65699390", exp: 1787349904 });
    const out = decodeLuat(luat);
    expect(out.userId).toBe("11111111-2222-3333-4444-555555555555");
    expect(out.expiresAt).toBe("2026-08-21T22:05:04.000Z");
  });

  it("sub sans format lbc → userId null ; JWT illisible → tout null", () => {
    expect(decodeLuat(jwt({ sub: "autre", exp: 100 })).userId).toBeNull();
    expect(decodeLuat("pas.un.jwt")).toEqual({ userId: null, expiresAt: null });
  });
});
