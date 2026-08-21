import { describe, it, expect } from "vitest";
import { normalizeSessionImport, jwtExpiry, sessionExpiresAt, SessionImportSchema } from "../../apps/server/src/session.js";

// JWT de test : header.payload.signature avec exp = 1800000000 (2027-01-15)
function fakeJwt(exp?: number): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc(exp ? { exp } : { sub: "42" })}.${"sig".repeat(10)}`;
}

describe("import de session", () => {
  it("format manuel : luat + userId + UA", () => {
    const input = SessionImportSchema.parse({
      format: "manual",
      luat: fakeJwt(1_800_000_000),
      userId: "12345",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131",
    });
    const bundle = normalizeSessionImport(input);
    expect(bundle.cookies["luat"]).toBeDefined();
    expect(bundle.userId).toBe("12345");
    expect(sessionExpiresAt(bundle)?.getTime()).toBe(1_800_000_000_000);
  });

  it("format cookie-editor : extraction du luat obligatoire", () => {
    const ok = normalizeSessionImport(
      SessionImportSchema.parse({
        format: "cookie-editor",
        json: JSON.stringify([
          { name: "lbc_user_id", value: "77" },
          { name: "luat", value: fakeJwt() },
        ]),
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131",
      })
    );
    expect(ok.userId).toBe("77");

    expect(() =>
      normalizeSessionImport(
        SessionImportSchema.parse({ format: "cookie-editor", json: '[{"name":"x","value":"y"}]', userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131" })
      )
    ).toThrow(/luat/);
  });

  it("format playwright storageState", () => {
    const state = {
      cookies: [
        { name: "luat", value: fakeJwt(1_900_000_000), domain: ".leboncoin.fr" },
        { name: "lbc_user_id", value: "9" },
      ],
      origins: [{ origin: "https://www.leboncoin.fr", localStorage: [{ name: "jwt", value: "x" }] }],
    };
    const bundle = normalizeSessionImport(SessionImportSchema.parse({ format: "playwright", storageState: JSON.stringify(state) }));
    expect(bundle.localStorage["jwt"]).toBe("x");
    expect(bundle.cookies["luat"]).toBeDefined();
  });

  it("luat trop court rejeté (ce n'est pas un JWT)", () => {
    expect(() =>
      SessionImportSchema.parse({ format: "manual", luat: "court", userId: "1", userAgent: "UA/1.0" })
    ).toThrow();
  });
});

describe("expiration JWT", () => {
  it("exp décodé, token non-JWT → null", () => {
    expect(jwtExpiry(fakeJwt(1_800_000_000))?.getTime()).toBe(1_800_000_000_000);
    expect(jwtExpiry("pas.un.jwt")).toBeNull();
    expect(jwtExpiry(fakeJwt())).toBeNull(); // sans exp
  });
});
