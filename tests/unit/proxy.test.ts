import { describe, it, expect } from "vitest";
import { parseProxy, proxyUrl, toAnySolverProxy } from "../../apps/server/src/domain/proxy.js";

describe("parseProxy — host:port:user:pass", () => {
  it("parse le format canonique", () => {
    const p = parseProxy("proxy.example.com:3128:user1:pass1");
    expect(p).toEqual({ type: "http", host: "proxy.example.com", port: 3128, username: "user1", password: "pass1" });
  });

  it("garde les ':' dans le mot de passe", () => {
    const p = parseProxy("proxy.example.com:3128:user:p@ss:with:colons");
    expect(p.username).toBe("user");
    expect(p.password).toBe("p@ss:with:colons");
  });

  it("rejette un port non numérique", () => {
    expect(() => parseProxy("host:abc:user:pass")).toThrow(/Port proxy invalide/);
  });

  it("rejette un port hors bornes", () => {
    expect(() => parseProxy("host:70000:user:pass")).toThrow(/Port proxy invalide/);
  });

  it("rejette les formats incomplets", () => {
    expect(() => parseProxy("host:8080")).toThrow(/proxy/i);
    expect(() => parseProxy("")).toThrow(/vide/);
    expect(() => parseProxy("host:8080:useronly")).toThrow(/proxy/i);
  });
});

describe("parseProxy — user:pass@host:port (credentials-first)", () => {
  it("parse le format credentials-first", () => {
    const p = parseProxy("user-country-FR:pass1234@proxy.example.com:8080");
    expect(p).toEqual({
      type: "http",
      host: "proxy.example.com",
      port: 8080,
      username: "user-country-FR",
      password: "pass1234",
    });
  });

  it("accepte un schéma http:// explicite", () => {
    const p = parseProxy("http://user:pass@proxy.io:8080");
    expect(p.host).toBe("proxy.io");
    expect(p.port).toBe(8080);
  });

  it("distingue la variante sticky session du rotatif", () => {
    const rotating = parseProxy("user-country-FR:pass1234@proxy.example.com:8080");
    const sticky = parseProxy("user-country-FR-session-abc12-time-1:pass1234@proxy.example.com:8080");
    expect(rotating.username).not.toBe(sticky.username);
    expect(sticky.username).toContain("session-abc12");
  });
});

describe("dérivations", () => {
  it("proxyUrl encode les identifiants", () => {
    const url = proxyUrl({ type: "http", host: "h.io", port: 8080, username: "u@1", password: "p:2" });
    expect(url).toBe("http://u%401:p%3A2@h.io:8080");
  });

  it("toAnySolverProxy expose l'objet contrat officiel", () => {
    expect(toAnySolverProxy({ type: "http", host: "h", port: 1, username: "u", password: "p" })).toEqual({
      type: "http", host: "h", port: 1, username: "u", password: "p",
    });
  });
});
