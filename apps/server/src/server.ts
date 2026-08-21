import Fastify, { type FastifyInstance, type FastifyBaseLogger } from "fastify";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ZodError } from "zod";
import type { AppConfig } from "./config.js";
import type { Db } from "./db.js";
import { createRepos, type Repos } from "./repos.js";
import { Bus } from "./bus.js";
import type { SearchEngine } from "./adapters/leboncoin/engine.js";
import type { SchedulerHandle } from "./jobs/scheduler.js";
import type { OutboxHandle } from "./jobs/outbox.js";
import type { SecretVault } from "./security/vault.js";
import { AppError } from "./security/errors.js";
import { seed } from "./seed.js";
import { coreRoutes } from "./routes/core.js";
import { listingsRoutes } from "./routes/listings.js";
import { messagingRoutes } from "./routes/messaging.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { systemRoutes, type SystemDeps } from "./routes/system.js";
import type { AppCtx } from "./routes/types.js";
import type { CaptureSession } from "./adapters/chrome/capture.js";
import type { MessagingAdapter } from "./adapters/leboncoin/messaging.js";
import type { ProxyConfig } from "./domain/proxy.js";
import { logger } from "./logger.js";

export interface BuildOptions {
  cfg: AppConfig;
  db: Db;
  vault: SecretVault;
  engine: SearchEngine;
  repos?: Repos;
  bus?: Bus;
  scheduler?: SchedulerHandle | null;
  outbox?: OutboxHandle | null;
  runSeed?: boolean;
  system?: {
    capture: CaptureSession;
    messaging: MessagingAdapter;
    getProxyFor(kind: "search" | "messaging"): Promise<ProxyConfig | null>;
    storedProxy(): Promise<ProxyConfig | null>;
    autoResponder?: { processAndReply(automationEnabled: boolean): Promise<unknown> };
  };
}

export async function buildServer(opts: BuildOptions): Promise<FastifyInstance> {
  const { cfg, db, vault, engine } = opts;
  const repos = opts.repos ?? createRepos(db, (cipher) => vault.decrypt(cipher));
  const bus = opts.bus ?? new Bus(repos.events);

  if (opts.runSeed !== false) seed(repos, bus);

  // pino 9 structurellement compatible, écart de typage mineur (msgPrefix) — cast contrôlé
  const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger, bodyLimit: 2 * 1024 * 1024 });

  const ctx: AppCtx = {
    cfg,
    repos,
    bus,
    engine,
    scheduler: opts.scheduler ?? null,
    outbox: opts.outbox ?? null,
    vault,
    startedAt: Date.now(),
    version: "0.1.0",
    llmApiKey: async () => {
      const cipher = repos.secrets.get("llm_key");
      return cipher ? vault.decrypt(cipher) : null;
    },
  };

  void app.register(cors, {
    origin: [cfg.WEB_ORIGIN, "http://localhost:5173", "http://127.0.0.1:5173"],
  });

  // En prod locale : sert le frontend construit (apps/web/dist) sur le même port.
  const webDist = join(import.meta.dirname ?? process.cwd(), "../../web/dist");
  const hasWebDist = existsSync(webDist);
  if (hasWebDist) {
    const fastifyStatic = await import("@fastify/static");
    await app.register(fastifyStatic.default, { root: webDist, prefix: "/" });
  }

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      reply.status(err.status).send({
        error: { code: err.code, message: err.message, retryable: err.retryable, correlationId: err.correlationId },
      });
      return;
    }
    if (err instanceof ZodError) {
      reply.status(400).send({
        error: {
          code: "validation_error",
          message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          retryable: false,
          correlationId: randomUUID(),
        },
      });
      return;
    }
    const correlationId = randomUUID();
    const asErr = err as Error;
    req.log.error({ err: asErr, correlationId }, "erreur non gérée");
    reply.status(500).send({
      error: { code: "internal_error", message: asErr.message, retryable: false, correlationId },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) {
      reply.status(404).send({
        error: { code: "not_found", message: `Route inconnue : ${req.method} ${req.url}`, retryable: false, correlationId: randomUUID() },
      });
      return;
    }
    if (hasWebDist) {
      void reply.sendFile("index.html");
      return;
    }
    reply.status(404).send({
      error: { code: "not_found", message: `Route inconnue : ${req.method} ${req.url}`, retryable: false, correlationId: randomUUID() },
    });
  });

  coreRoutes(app, ctx);
  listingsRoutes(app, ctx);
  messagingRoutes(app, ctx, opts.system?.messaging);
  webhookRoutes(app, ctx);
  if (opts.system) {
    const deps: SystemDeps = {
      capture: opts.system.capture,
      getProxyFor: opts.system.getProxyFor,
      storedProxy: opts.system.storedProxy,
      ...(opts.system.autoResponder ? { autoResponder: opts.system.autoResponder } : {}),
    };
    systemRoutes(app, ctx, deps);
  }

  return app;
}
