import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { RouteModule, AppCtx } from "./types.js";
import { SessionImportSchema, normalizeSessionImport, sessionExpiresAt } from "../session.js";
import { AppError, badRequest, unavailable } from "../security/errors.js";
import { stickyCheck } from "../diagnostics.js";
import { AnySolverClient, SolverError } from "../adapters/anysolver/client.js";
import { LlmClient } from "../adapters/llm/gemini.js";

function isoNow() {
  return new Date().toISOString();
}

export const coreRoutes: RouteModule = (app: FastifyInstance, ctx: AppCtx) => {
  app.get("/api/v1/status", async () => {
    return {
      version: ctx.version,
      uptimeSeconds: Math.floor((Date.now() - ctx.startedAt) / 1000),
      mode: ctx.cfg.LBC_MODE,
      scheduler: {
        running: ctx.scheduler !== null,
        nextRunAt: ctx.scheduler?.nextRunAt()?.toISOString() ?? null,
      },
      automation: {
        enabled: ctx.repos.settings.get("automation_enabled") === "1",
        killSwitch: ctx.repos.settings.get("kill_switch") === "1",
      },
      counters: {
        listings: ctx.repos.listings.count(),
        watches: ctx.repos.watches.list().length,
        conversations: ctx.repos.conversations.count(),
        pendingDeliveries: ctx.repos.webhooks.pendingCount(),
      },
    };
  });

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  app.post("/api/v1/session/import", async (req) => {
    const input = SessionImportSchema.parse(req.body);
    const bundle = normalizeSessionImport(input);
    const cipher = await ctx.vault.encrypt(JSON.stringify(bundle));
    ctx.repos.secrets.set("lbc_session", cipher);
    ctx.repos.audit.insert("session.import", { format: bundle.format, userId: bundle.userId });
    const expiresAt = sessionExpiresAt(bundle);
    return { ok: true, userId: bundle.userId, expiresAt, vault: ctx.vault.kind };
  });

  app.get("/api/v1/session/status", async () => {
    const cipher = ctx.repos.secrets.get("lbc_session");
    if (!cipher) {
      return { imported: false, userId: null, userAgent: null, expiresAt: null, expiresSoon: false, mode: ctx.cfg.LBC_MODE };
    }
    const bundle = JSON.parse(await ctx.vault.decrypt(cipher)) as {
      userId: string | null;
      userAgent: string;
      cookies: Record<string, string>;
      expiresAt?: string;
    };
    const expiresAt = bundle.expiresAt ?? sessionExpiresAt(bundle);
    const expiresAtMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : expiresAt?.getTime();
    const expiresSoon = expiresAtMs !== undefined && expiresAtMs !== null && !Number.isNaN(expiresAtMs) && expiresAtMs - Date.now() < 48 * 3600_000;
    return {
      imported: true,
      userId: bundle.userId,
      userAgent: bundle.userAgent,
      expiresAt,
      expiresSoon,
      mode: ctx.cfg.LBC_MODE,
    };
  });

  app.delete("/api/v1/session", async () => {
    ctx.repos.secrets.delete("lbc_session");
    ctx.repos.audit.insert("session.delete", {});
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // SSE
  // -------------------------------------------------------------------------

  app.get("/api/v1/events", (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    reply.raw.write(`retry: 5000\n\n`);
    const unsubscribe = ctx.bus.addSseClient((e) => {
      reply.raw.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    });
    const heartbeat = setInterval(() => reply.raw.write(`: ping ${Date.now()}\n\n`), 15_000);
    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get("/api/v1/events/recent", async () => {
    return { events: ctx.repos.events.recent(50) };
  });

  app.get("/api/v1/audit", async () => {
    return { entries: ctx.repos.audit.recent(100) };
  });

  // -------------------------------------------------------------------------
  // Automation & kill switch
  // -------------------------------------------------------------------------

  const toggle = (key: string, value: string) => async () => {
    ctx.repos.settings.set(key, value);
    ctx.repos.audit.insert(`settings.${key}`, { value });
    ctx.bus.publish(value === "1" ? `${key}.enabled` : `${key}.disabled`, {});
    return { ok: true, [key]: value === "1" };
  };

  app.post("/api/v1/automation/enable", toggle("automation_enabled", "1"));
  app.post("/api/v1/automation/disable", toggle("automation_enabled", "0"));
  app.post("/api/v1/system/kill-switch", async (req) => {
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    ctx.repos.settings.set("kill_switch", body.enabled ? "1" : "0");
    ctx.repos.audit.insert("settings.kill_switch", { enabled: body.enabled });
    ctx.bus.publish(body.enabled ? "kill_switch.on" : "kill_switch.off", {});
    return { ok: true, killSwitch: body.enabled };
  });

  // -------------------------------------------------------------------------
  // Diagnostics — chaque sonde joue direct vs proxy
  // -------------------------------------------------------------------------

  app.get("/api/v1/diagnostics", async () => {
    return {
      mode: ctx.cfg.LBC_MODE,
      proxyConfigured: ctx.repos.secrets.get("proxy") !== null || !!ctx.cfg.LBC_PROXY,
      anysolverConfigured: ctx.repos.secrets.get("anysolver_key") !== null,
      llmConfigured: !!(await ctx.llmApiKey()) && !!ctx.cfg.LLM_BASE_URL,
      vault: ctx.vault.kind,
      lastSticky: JSON.parse(ctx.repos.settings.get("last_sticky_result") ?? "null") as unknown,
    };
  });

  app.post("/api/v1/diagnostics/proxy-sticky", async (req) => {
    const body = z.object({ proxy: z.string().optional(), save: z.boolean().default(false) }).parse(req.body ?? {});
    const raw = body.proxy ?? ctx.repos.secrets.get("proxy") ?? ctx.cfg.LBC_PROXY;
    if (!raw) throw badRequest("Aucun proxy fourni ni stocké");
    const result = await stickyCheck(raw);
    ctx.repos.settings.set("last_sticky_result", JSON.stringify({ at: isoNow(), ...result }));
    if (body.save) {
      ctx.repos.secrets.set("proxy", await ctx.vault.encrypt(raw));
      ctx.repos.audit.insert("proxy.save", {});
    }
    return result;
  });

  app.post("/api/v1/diagnostics/anysolver", async (req) => {
    const body = z.object({ apiKey: z.string().optional() }).parse(req.body ?? {});
    const key = body.apiKey ?? (await secretOrThrow(ctx, "anysolver_key"));
    if (body.apiKey) {
      ctx.repos.secrets.set("anysolver_key", await ctx.vault.encrypt(body.apiKey));
      ctx.repos.audit.insert("anysolver.key_saved", {});
    }
    try {
      const client = new AnySolverClient({ apiKey: key });
      const balance = await client.balance();
      return { ok: true, balance };
    } catch (err) {
      if (err instanceof SolverError) throw new AppError("solver_error", err.message, { status: 502, retryable: !err.permanent, correlationId: randomUUID() });
      throw err;
    }
  });

  app.post("/api/v1/diagnostics/llm", async () => {
    const key = await ctx.llmApiKey();
    if (!key || !ctx.cfg.LLM_BASE_URL) throw unavailable("LLM non configuré (clé + base URL requis)");
    const t0 = Date.now();
    const client = new LlmClient({ baseUrl: ctx.cfg.LLM_BASE_URL, apiKey: key, model: ctx.cfg.LLM_MODEL });
    const text = await client.complete("Réponds uniquement par: pong", [{ role: "user", content: "ping" }]);
    return { ok: true, model: ctx.cfg.LLM_MODEL, latencyMs: Date.now() - t0, sample: text.slice(0, 50) };
  });
};

async function secretOrThrow(ctx: AppCtx, name: string): Promise<string> {
  const cipher = ctx.repos.secrets.get(name);
  if (!cipher) throw unavailable(`Secret '${name}' non importé — écran Système`);
  return ctx.vault.decrypt(cipher);
}
