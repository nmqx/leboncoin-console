import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { LBC_CATEGORIES, rangeAttributesForCategory, SearchSpecSchema } from "@lbc/contracts";
import type { RouteModule } from "./types.js";
import { notFound } from "../security/errors.js";
import { dealScore, localSort, relevanceScore } from "../domain/scoring.js";
import { fixtureWatch } from "@lbc/fixtures";

export const listingsRoutes: RouteModule = (app: FastifyInstance, ctx) => {
  // -------------------------------------------------------------------------
  // Référentiel : catégories réelles Leboncoin + attributs de plage par famille
  // -------------------------------------------------------------------------

  app.get("/api/v1/categories", async (req) => {
    const q = z.object({ withAttrsFor: z.string().optional() }).parse(req.query ?? {});
    return {
      categories: Object.entries(LBC_CATEGORIES).map(([id, name]) => ({ id, name })),
      rangeAttributes: q.withAttrsFor ? rangeAttributesForCategory(q.withAttrsFor) : [],
    };
  });

  // -------------------------------------------------------------------------
  // Jobs de recherche
  // -------------------------------------------------------------------------

  app.post("/api/v1/search-jobs", async (req) => {
    const spec = SearchSpecSchema.parse(req.body);
    const jobId = `job-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const watchId = (req.body as { watchId?: number }).watchId ?? null;
    ctx.repos.jobs.create(jobId, watchId, spec, jobId);
    ctx.bus.publish("search.started", { jobId, correlationId: jobId });
    try {
      const result = await ctx.engine.run(jobId, spec, jobId, watchId);
      if (watchId !== null) ctx.repos.watches.linkListings(watchId, result.listingIds);
      ctx.repos.jobs.finish(jobId, "completed", {
        pageCount: result.pageCount,
        itemsFound: result.found,
        itemsNew: result.newCount,
      });
      const job = ctx.repos.jobs.byId(jobId)!;
      ctx.bus.publish("search.completed", { jobId, ...result });
      return job;
    } catch (err) {
      const e = err as Error & { code?: string };
      ctx.repos.jobs.finish(jobId, "quarantined", {
        error: { code: e.code ?? "engine_error", message: e.message, retryable: true },
      });
      ctx.bus.publish("search.failed", { jobId, code: e.code ?? "engine_error", message: e.message });
      return ctx.repos.jobs.byId(jobId)!;
    }
  });

  app.get("/api/v1/search-jobs/:id", async (req) => {
    const { id } = req.params as { id: string };
    const job = ctx.repos.jobs.byId(id);
    if (!job) throw notFound("Job");
    return job;
  });

  app.get("/api/v1/search-jobs", async () => {
    return { jobs: ctx.repos.jobs.recent(30) };
  });

  app.post("/api/v1/search-jobs/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    const job = ctx.repos.jobs.byId(id);
    if (!job) throw notFound("Job");
    if (job.status === "running") {
      ctx.repos.jobs.finish(id, "cancelled", {});
      ctx.bus.publish("search.cancelled", { jobId: id });
    }
    return ctx.repos.jobs.byId(id)!;
  });

  // -------------------------------------------------------------------------
  // Annonces
  // -------------------------------------------------------------------------

  const ListingsQuery = z.object({
    query: z.string().optional(),
    priceMin: z.coerce.number().int().optional(),
    priceMax: z.coerce.number().int().optional(),
    ownerType: z.enum(["private", "pro"]).optional(),
    shippable: z.coerce.boolean().optional(),
    department: z.string().optional(),
    category: z.string().optional(),
    sort: z.enum(["price", "publishedAt", "relevance", "distance"]).optional(),
    dir: z.enum(["asc", "desc"]).optional(),
    watchId: z.coerce.number().int().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  });

  app.get("/api/v1/listings", async (req) => {
    const q = ListingsQuery.parse(req.query);
    const { items, total } = ctx.repos.listings.search({
      query: q.query,
      priceMin: q.priceMin,
      priceMax: q.priceMax,
      ownerType: q.ownerType,
      shippable: q.shippable,
      department: q.department,
      category: q.category,
      watchId: q.watchId,
      limit: q.limit,
      offset: q.offset,
    });

    const rescored = items.map((l) => ({
      ...l,
      score: q.query ? relevanceScore(q.query, l) : l.score,
    }));
    const prices = rescored.map((l) => l.priceCents).filter((p): p is number => p !== undefined);
    const withDeal = rescored.map((l) => ({
      ...l,
      dealScore: l.priceCents !== undefined ? dealScore(l.priceCents, prices) : undefined,
    }));
    const sorted = q.sort
      ? (localSort(withDeal, [{ field: q.sort, direction: q.dir ?? "desc" }]) as typeof withDeal)
      : withDeal;

    return { items: sorted, total };
  });

  app.get("/api/v1/listings/:id", async (req) => {
    const { id } = req.params as { id: string };
    const listing = ctx.repos.listings.byId(id);
    if (!listing) throw notFound("Annonce");
    const peers = ctx.repos.listings.peerPrices(listing.category ?? null);
    const prices = peers.filter((p): p is number => p !== null);
    return {
      listing: {
        ...listing,
        dealScore: listing.priceCents !== undefined ? dealScore(listing.priceCents, prices) : undefined,
      },
      priceHistory: ctx.repos.listings.priceHistory(id),
    };
  });

  // -------------------------------------------------------------------------
  // Veilles
  // -------------------------------------------------------------------------

  const WatchCreate = z.object({
    name: z.string().min(1).max(80),
    spec: SearchSpecSchema,
    cadenceMinutes: z.number().int().min(1).max(1440).default(10),
  });

  app.get("/api/v1/watches", async () => {
    return {
      watches: ctx.repos.watches.list().map((w) => ({
        ...w,
        listingCount: ctx.repos.watches.listingCount(w.id),
        webhookIds: ctx.repos.webhooks.webhookIdsForWatch(w.id),
      })),
    };
  });

  app.post("/api/v1/watches", async (req) => {
    const body = WatchCreate.parse(req.body);
    const watch = ctx.repos.watches.create(body.name, body.spec, body.cadenceMinutes);
    ctx.repos.audit.insert("watch.create", { watchId: watch.id, name: watch.name });
    ctx.bus.publish("watch.created", { watchId: watch.id, name: watch.name });
    return watch;
  });

  app.patch("/api/v1/watches/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        name: z.string().min(1).max(80).optional(),
        spec: SearchSpecSchema.optional(),
        enabled: z.boolean().optional(),
        cadenceMinutes: z.number().int().min(1).max(1440).optional(),
      })
      .parse(req.body);
    const updated = ctx.repos.watches.update(Number(id), body);
    if (!updated) throw notFound("Veille");
    return updated;
  });

  app.delete("/api/v1/watches/:id", async (req) => {
    const { id } = req.params as { id: string };
    if (!ctx.repos.watches.delete(Number(id))) throw notFound("Veille");
    return { ok: true };
  });

  app.get("/api/v1/watches/:id/webhooks", async (req) => {
    const { id } = req.params as { id: string };
    const watch = ctx.repos.watches.byId(Number(id));
    if (!watch) throw notFound("Veille");
    const webhookIds = ctx.repos.webhooks.webhookIdsForWatch(watch.id);
    return { watchId: watch.id, webhookIds, webhooks: webhookIds.map((wid) => ctx.repos.webhooks.byId(wid)).filter(Boolean) };
  });

  app.put("/api/v1/watches/:id/webhooks", async (req) => {
    const { id } = req.params as { id: string };
    const watch = ctx.repos.watches.byId(Number(id));
    if (!watch) throw notFound("Veille");
    const body = z.object({ webhookIds: z.array(z.number().int()).default([]) }).parse(req.body);
    for (const wid of body.webhookIds) if (!ctx.repos.webhooks.byId(wid)) throw notFound(`Webhook ${wid}`);
    ctx.repos.webhooks.setWatchWebhooks(watch.id, body.webhookIds);
    ctx.repos.audit.insert("watch.webhooks", { watchId: watch.id, webhookIds: body.webhookIds });
    const webhookIds = ctx.repos.webhooks.webhookIdsForWatch(watch.id);
    return { watchId: watch.id, webhookIds, webhooks: webhookIds.map((wid) => ctx.repos.webhooks.byId(wid)).filter(Boolean) };
  });

  app.post("/api/v1/watches/:id/run", async (req) => {
    const { id } = req.params as { id: string };
    const watch = ctx.repos.watches.byId(Number(id));
    if (!watch) throw notFound("Veille");
    const jobId = `job-${Date.now()}-${watch.id}-${Math.floor(Math.random() * 1e4)}`;
    ctx.repos.jobs.create(jobId, watch.id, watch.spec, jobId);
    try {
      const result = await ctx.engine.run(jobId, watch.spec, jobId, watch.id);
      ctx.repos.watches.linkListings(watch.id, result.listingIds);
      ctx.repos.jobs.finish(jobId, "completed", {
        pageCount: result.pageCount,
        itemsFound: result.found,
        itemsNew: result.newCount,
      });
      ctx.repos.watches.markRun(watch.id, "completed");
      ctx.bus.publish("watch.completed", { watchId: watch.id, name: watch.name, jobId, ...result, manual: true });
      ctx.repos.webhooks.enqueueForWatch("watch.completed", watch.id, { watchId: watch.id, name: watch.name, jobId, ...result, manual: true });
    } catch (err) {
      const e = err as Error & { code?: string };
      ctx.repos.jobs.finish(jobId, "quarantined", {
        error: { code: e.code ?? "engine_error", message: e.message, retryable: true },
      });
      ctx.repos.watches.markRun(watch.id, "quarantined");
      ctx.bus.publish("challenge.failed", { watchId: watch.id, name: watch.name, code: e.code ?? "engine_error", message: e.message });
      ctx.repos.webhooks.enqueueForWatch("challenge.failed", watch.id, { watchId: watch.id, name: watch.name, code: e.code ?? "engine_error", message: e.message });
    }
    return ctx.repos.jobs.byId(jobId)!;
  });

  void fixtureWatch;
};
