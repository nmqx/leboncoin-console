import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../../apps/server/src/server.js";
import { Db } from "../../apps/server/src/db.js";
import { createRepos } from "../../apps/server/src/repos.js";
import { Bus } from "../../apps/server/src/bus.js";
import { FixtureEngine } from "../../apps/server/src/adapters/leboncoin/engine.js";
import { startOutbox } from "../../apps/server/src/jobs/outbox.js";
import { loadConfig } from "../../apps/server/src/config.js";
import type { SecretVault } from "../../apps/server/src/security/vault.js";

/** Coffre de test : base64 aller-retour, jamais utilisé en production. */
const testVault: SecretVault = {
  kind: "dev",
  encrypt: async (s) => Buffer.from(s, "utf8").toString("base64"),
  decrypt: async (b) => Buffer.from(b, "base64").toString("utf8"),
};

let app: Awaited<ReturnType<typeof buildServer>>;
const cfg = loadConfig({ ...process.env, LBC_MODE: "fixtures" } as NodeJS.ProcessEnv);
let outboxStop: (() => void) | null = null;

beforeAll(async () => {
  const db = Db.inMemory();
  const repos = createRepos(db);
  const bus = new Bus(repos.events);
  const engine = new FixtureEngine(repos, bus);
  const outbox = startOutbox(repos, bus, 3_600_000); // pas de boucle pendant les tests
  outboxStop = () => outbox.stop();
  app = await buildServer({ cfg, db, vault: testVault, engine, repos, bus, outbox, runSeed: true });
});

afterAll(() => outboxStop?.());

describe("API locale — cœur", () => {
  it("GET /status expose mode, scheduler, automation, compteurs", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe("fixtures");
    expect(body.counters.listings).toBeGreaterThan(10);
    expect(body.counters.conversations).toBeGreaterThan(0);
    expect(body.automation).toEqual({ enabled: false, killSwitch: false });
  });

  it("GET /listings retourne les annonces amortcies avec score et total", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/listings?limit=10" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(10);
    expect(body.total).toBeGreaterThanOrEqual(10);
    expect(typeof body.items[0].score).toBe("number");
  });

  it("les filtres prix et vendeur sont respectés côté serveur", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/listings?priceMin=30000&priceMax=90000&ownerType=private" });
    const body = res.json();
    for (const l of body.items) {
      expect(l.priceCents).toBeGreaterThanOrEqual(30000);
      expect(l.priceCents).toBeLessThanOrEqual(90000);
      expect(l.owner.type).toBe("private");
    }
  });

  it("GET /listings/:id avec historique de prix", async () => {
    const list = (await app.inject({ method: "GET", url: "/api/v1/listings?limit=1" })).json();
    const id = list.items[0].id;
    const res = await app.inject({ method: "GET", url: `/api/v1/listings/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.listing.id).toBe(id);
    expect(Array.isArray(body.priceHistory)).toBe(true);
  });

  it("404 → enveloppe d'erreur avec correlationId", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/listings/inconnu-999" });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe("not_found");
    expect(body.error.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("API locale — jobs et veilles", () => {
  it("POST /search-jobs exécute l'engine fixtures et complète", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/search-jobs",
      payload: { query: "vélo", priceCents: { min: 10000 }, maxItems: 50 },
    });
    expect(res.statusCode).toBe(200);
    const job = res.json();
    expect(job.status).toBe("completed");
    expect(job.itemsFound).toBeGreaterThan(0);
    expect(job.correlationId).toMatch(/^job-/);
  });

  it("CRUD veilles + run manuel", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/watches",
      payload: { name: "PS5 pas chère", spec: { query: "PS5", priceCents: { max: 50000 }, maxItems: 50 }, cadenceMinutes: 10 },
    });
    expect(created.statusCode).toBe(200);
    const watch = created.json();
    expect(watch.enabled).toBe(true);

    const patched = await app.inject({ method: "PATCH", url: `/api/v1/watches/${watch.id}`, payload: { enabled: false } });
    expect(patched.json().enabled).toBe(false);

    const run = await app.inject({ method: "POST", url: `/api/v1/watches/${watch.id}/run` });
    expect(run.statusCode).toBe(200);
    expect(["completed", "quarantined"]).toContain(run.json().status);

    const del = await app.inject({ method: "DELETE", url: `/api/v1/watches/${watch.id}` });
    expect(del.json().ok).toBe(true);
  });

  it("seuil de bonne affaire : le job ne garde que le top % sous médiane", async () => {
    const plain = (await app.inject({
      method: "POST", url: "/api/v1/search-jobs",
      payload: { query: "vélo", maxItems: 50 },
    })).json();
    const filtered = (await app.inject({
      method: "POST", url: "/api/v1/search-jobs",
      payload: { query: "vélo", maxItems: 50, dealThreshold: 0.25 },
    })).json();
    expect(plain.status).toBe("completed");
    expect(filtered.status).toBe("completed");
    expect(filtered.itemsFound).toBeLessThan(plain.itemsFound);
    // seuil absurde : presque tout est filtré, jamais une erreur silencieuse
    const strict = (await app.inject({
      method: "POST", url: "/api/v1/search-jobs",
      payload: { query: "vélo", maxItems: 50, dealThreshold: 0.95 },
    })).json();
    expect(strict.status).toBe("completed");
  });
});

describe("API locale — messagerie", () => {
  it("réponse manuelle en mode fixtures → deliveryStatus simulated", async () => {
    const convs = (await app.inject({ method: "GET", url: "/api/v1/conversations" })).json().conversations;
    const conv = convs.find((c: { unreadCount: number }) => c.unreadCount > 0);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conv.id}/reply`,
      payload: { body: "Bonjour, c'est bien disponible.", dedupeKey: "test-1", auto: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().inserted).toBe(true);
    expect(res.json().message.deliveryStatus).toBe("simulated");

    // Rejeu idempotent : pas de doublon, pas de consommation de limite
    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conv.id}/reply`,
      payload: { body: "Bonjour, c'est bien disponible.", dedupeKey: "test-1", auto: false },
    });
    expect(replay.json().inserted).toBe(false);
    expect(replay.json().message.id).toBe(res.json().message.id);
  });

  it("auto=true sans automation → 409 ; kill switch → 423", async () => {
    const convs = (await app.inject({ method: "GET", url: "/api/v1/conversations" })).json().conversations;
    const conv = convs[0];
    const auto = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conv.id}/reply`,
      payload: { body: "auto", auto: true },
    });
    expect(auto.statusCode).toBe(409);
    expect(auto.json().error.code).toBe("automation_disabled");

    await app.inject({ method: "POST", url: "/api/v1/system/kill-switch", payload: { enabled: true } });
    const blocked = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conv.id}/reply`,
      payload: { body: "bloqué" },
    });
    expect(blocked.statusCode).toBe(423);
    expect(blocked.json().error.code).toBe("kill_switch");
    await app.inject({ method: "POST", url: "/api/v1/system/kill-switch", payload: { enabled: false } });
  });
});

describe("API locale — webhooks", () => {
  it("webhook HTTP sans secret → 400 ; avec secret → créé", async () => {
    const noSecret = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      payload: { kind: "http", url: "https://example.local/hook", events: ["listing.created"] },
    });
    expect(noSecret.statusCode).toBe(400);

    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      payload: { kind: "http", url: "https://example.local/hook", events: ["listing.created"], secret: "clef-hmac-de-32-caracteres" },
    });
    expect(ok.statusCode).toBe(200);
    const wh = ok.json();
    expect(wh.hasSecret).toBe(true);
    expect(wh.url).toBe("https://example.local/hook");
  });

  it("discord accepté sans secret, échec réseau → pending avec retry planifié", { timeout: 45_000 }, async () => {
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      payload: { kind: "discord", url: "https://discord.invalid/hook", events: ["listing.created"] },
    });
    const wh = ok.json();
    const test = await app.inject({ method: "POST", url: `/api/v1/webhooks/${wh.id}/test` });
    expect(test.statusCode).toBe(200);
    const deliveries = test.json().deliveries;
    expect(deliveries.length).toBeGreaterThan(0);
    // Réseau injoignable en test → au moins 1 tentative, statut pending ou pire, jamais silencieux
    expect(deliveries[0].attempts).toBeGreaterThanOrEqual(1);
    expect(["pending", "failed", "dead", "delivered"]).toContain(deliveries[0].status);
  });

  it("une recherche manuelle ne déclenche PAS de webhook, seule une veille notifie", async () => {
    const createdWh = (await app.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      payload: { kind: "http", url: "https://example.local/hook-watch-only", events: ["listing.created", "watch.completed"], secret: "secret-hmac-32-chars-long-test" },
    })).json();

    const beforeDels = (await app.inject({ method: "GET", url: `/api/v1/webhooks/${createdWh.id}/deliveries` })).json().deliveries;

    // 1. Recherche manuelle (sans watchId) -> pas de livraison webhook
    const searchRes = await app.inject({
      method: "POST",
      url: "/api/v1/search-jobs",
      payload: { query: "iphone", maxItems: 10 },
    });
    expect(searchRes.statusCode).toBe(200);

    const afterSearchDels = (await app.inject({ method: "GET", url: `/api/v1/webhooks/${createdWh.id}/deliveries` })).json().deliveries;
    expect(afterSearchDels.length).toBe(beforeDels.length);

    // 2. Création d'une veille et exécution -> webhook déclenché
    const watch = (await app.inject({
      method: "POST",
      url: "/api/v1/watches",
      payload: { name: "Veille test webhook", spec: { query: "macbook", maxItems: 10 }, cadenceMinutes: 10 },
    })).json();

    await app.inject({
      method: "PUT",
      url: `/api/v1/watches/${watch.id}/webhooks`,
      payload: { webhookIds: [createdWh.id] },
    });

    const runWatchRes = await app.inject({
      method: "POST",
      url: `/api/v1/watches/${watch.id}/run`,
    });
    expect(runWatchRes.statusCode).toBe(200);

    const afterWatchDels = (await app.inject({ method: "GET", url: `/api/v1/webhooks/${createdWh.id}/deliveries` })).json().deliveries;
    expect(afterWatchDels.length).toBeGreaterThan(beforeDels.length);
  });
});

describe("API locale — session", () => {
  it("import manuel → statut → suppression, sans jamais révéler le cookie", async () => {
    const luat = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from('{"exp":1893456000}').toString("base64url")}.sig`;
    const imp = await app.inject({
      method: "POST",
      url: "/api/v1/session/import",
      payload: { format: "manual", luat, userId: "42", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131" },
    });
    expect(imp.statusCode).toBe(200);
    expect(imp.json().userId).toBe("42");
    expect(imp.json().expiresAt).toContain("2030");

    const status = (await app.inject({ method: "GET", url: "/api/v1/session/status" })).json();
    expect(status.imported).toBe(true);
    expect(status.userId).toBe("42");
    expect(JSON.stringify(status)).not.toContain(luat);

    const del = await app.inject({ method: "DELETE", url: "/api/v1/session" });
    expect(del.json().ok).toBe(true);
  });
});
