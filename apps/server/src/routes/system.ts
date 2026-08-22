import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { AppCtx } from "./types.js";
import { badRequest } from "../security/errors.js";
import { WreqTransport } from "../adapters/leboncoin/wreq-transport.js";
import { classifyDataDome } from "../adapters/leboncoin/datadome.js";
import { buildSearchUrl } from "../adapters/leboncoin/live.js";
import type { CaptureSession } from "../adapters/chrome/capture.js";
import type { ProxyConfig } from "../domain/proxy.js";
import type { SearchSpec } from "@lbc/contracts";

export interface SystemDeps {
  capture: CaptureSession;
  getProxyFor(kind: "search" | "messaging"): Promise<ProxyConfig | null>;
  /** Proxy stocké brut, hors politique — pour les comparaisons direct vs proxy. */
  storedProxy(): Promise<ProxyConfig | null>;
  autoResponder?: { processAndReply(automationEnabled: boolean): Promise<unknown> };
}

const RoutingSchema = z.object({
  search: z.enum(["direct", "proxy"]),
  messaging: z.enum(["direct", "proxy"]),
});

export function systemRoutes(app: FastifyInstance, ctx: AppCtx, deps: SystemDeps): void {
  // -------------------------------------------------------------------------
  // Connexion Chrome + capture DevTools
  // -------------------------------------------------------------------------

  app.post("/api/v1/session/chrome/start", async () => {
    if (deps.capture.running) {
      return { ok: true, alreadyRunning: true, status: deps.capture.status() };
    }
    const status = await deps.capture.start({ encrypt: (s) => ctx.vault.encrypt(s) });
    return {
      ok: true,
      status,
      instructions:
        "Chrome est ouvert sur leboncoin.fr — la session s'importe automatiquement dès la connexion. Parcourez la messagerie (inbox + un envoi) pour les contrats, puis « Terminer ».",
    };
  });

  app.get("/api/v1/session/chrome/status", async () => {
    return {
      running: deps.capture.running,
      status: deps.capture.status(),
      captured: ctx.repos.captured.list(50),
    };
  });

  app.post("/api/v1/session/chrome/finish", async () => {
    if (!deps.capture.running) throw badRequest("Aucune capture en cours");
    const result = await deps.capture.finish({
      encrypt: (s) => ctx.vault.encrypt(s),
    });
    return result;
  });

  app.post("/api/v1/session/refresh", async () => {
    const { refreshSession } = await import("../adapters/chrome/token-refresh.js");
    const result = await refreshSession({
      vault: ctx.vault,
      repos: ctx.repos,
      bus: ctx.bus,
      dataDir: ctx.cfg.DATA_DIR,
      livePage: deps.capture.running ? deps.capture.livePage() : null,
    });
    return result;
  });

  app.get("/api/v1/captured-requests", async (req) => {
    const q = z.object({ kind: z.enum(["inbox", "send", "api", "other"]).optional() }).parse(req.query ?? {});
    return { captured: ctx.repos.captured.list(200, q.kind) };
  });

  // -------------------------------------------------------------------------
  // Politique de routage : chaque flux passe par le proxy ou en direct
  // -------------------------------------------------------------------------

  app.get("/api/v1/system/routing", async () => {
    const raw = ctx.repos.settings.get("routing");
    const parsed = RoutingSchema.safeParse(raw ? JSON.parse(raw) : null);
    return parsed.success ? parsed.data : { search: "direct", messaging: "direct" };
  });

  app.put("/api/v1/system/routing", async (req) => {
    const body = RoutingSchema.parse(req.body);
    ctx.repos.settings.set("routing", JSON.stringify(body));
    ctx.repos.audit.insert("settings.routing", body);
    ctx.bus.publish("routing.changed", body);
    return { ok: true, routing: body };
  });

  // -------------------------------------------------------------------------
  // Pipeline messagerie : sync (+ réponses auto si automation activée)
  // -------------------------------------------------------------------------

  app.post("/api/v1/conversations/auto-process", async () => {
    if (!deps.autoResponder) throw badRequest("Pipeline messagerie indisponible (mode live requis)");
    const automation = ctx.repos.settings.get("automation_enabled") === "1";
    return await deps.autoResponder.processAndReply(automation);
  });

  // -------------------------------------------------------------------------
  // Stress test : la même recherche jouée N fois, direct ou via proxy
  // -------------------------------------------------------------------------

  app.post("/api/v1/diagnostics/stress", async (req) => {
    const body = z
      .object({
        count: z.number().int().min(1).max(30).default(12),
        useProxy: z.boolean().default(false),
        freshSession: z.boolean().default(false),
        gapMs: z.number().int().min(0).max(5000).default(150),
        query: z.string().default("vélo route"),
      })
      .parse(req.body ?? {});
    const proxy = body.useProxy ? await deps.storedProxy() : null;
    if (body.useProxy && !proxy) throw badRequest("Proxy demandé mais aucun proxy stocké/configuré");

    const sharedTransport = body.freshSession ? null : new WreqTransport({ proxy: proxy ?? undefined });
    const spec: SearchSpec = { query: body.query, maxItems: 35, filterJunk: true, llmFilter: false };
    const url = buildSearchUrl(spec, 0);
    const results: Array<{ status: number; latencyMs: number; datadome: boolean; challengeKind: string | null; items: number | null }> = [];

    for (let i = 0; i < body.count; i++) {
      const transport = sharedTransport ?? new WreqTransport({ proxy: proxy ?? undefined });
      const t0 = Date.now();
      try {
        const res = await transport.request({ url });
        const challenge = res.status === 403 ? classifyDataDome({ status: 403, url, body: res.body }) : null;
        let items: number | null = null;
        if (res.status === 200) {
          const m = res.body.match(/"total":(\d+)/);
          items = m ? Number(m[1]) : null;
        }
        results.push({
          status: res.status,
          latencyMs: Date.now() - t0,
          datadome: challenge !== null,
          challengeKind: challenge?.kind ?? null,
          items,
        });
      } catch {
        results.push({ status: -1, latencyMs: Date.now() - t0, datadome: false, challengeKind: null, items: null });
      }
      await new Promise((r) => setTimeout(r, body.gapMs));
    }

    const ok200 = results.filter((r) => r.status === 200).length;
    const dd = results.filter((r) => r.datadome).length;
    const latencies = results.filter((r) => r.status === 200).map((r) => r.latencyMs).sort((a, b) => a - b);
    ctx.repos.audit.insert("stress", {
      count: body.count, useProxy: body.useProxy, freshSession: body.freshSession, gapMs: body.gapMs, ok200, datadome: dd,
    });
    return {
      leg: `${body.useProxy ? "proxy" : "direct"}${body.freshSession ? " + session fraîche/req" : " + jar partagé"}`,
      count: body.count,
      ok200,
      datadome: dd,
      other: results.length - ok200,
      p50Ms: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
      p95Ms: latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] : null,
      results,
    };
  });
}
