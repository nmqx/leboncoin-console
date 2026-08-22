import { z } from "zod";
import { EventNameSchema } from "@lbc/contracts";
import type { FastifyInstance } from "fastify";
import type { RouteModule } from "./types.js";
import { notFound, badRequest } from "../security/errors.js";

export const webhookRoutes: RouteModule = (app: FastifyInstance, ctx) => {
  const WebhookCreate = z
    .object({
      kind: z.enum(["discord", "http"]),
      url: z.string().url(),
      events: z.array(EventNameSchema).min(1),
      secret: z.string().min(16).optional(),
    })
    .refine((b) => b.kind === "discord" || !!b.secret, {
      message: "Un webhook HTTP générique exige un secret de signature (HMAC)",
      path: ["secret"],
    });

  app.get("/api/v1/webhooks", async () => {
    return { webhooks: ctx.repos.webhooks.list() };
  });

  app.post("/api/v1/webhooks", async (req) => {
    const body = WebhookCreate.parse(req.body);
    const secretCipher = body.secret ? await ctx.vault.encrypt(body.secret) : null;
    const webhook = ctx.repos.webhooks.create(body.kind, body.url, body.events, secretCipher);
    ctx.repos.audit.insert("webhook.create", { webhookId: webhook.id, kind: webhook.kind });
    return webhook;
  });

  app.patch("/api/v1/webhooks/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ url: z.string().url().optional(), enabled: z.boolean().optional(), events: z.array(EventNameSchema).optional() })
      .parse(req.body);
    const updated = ctx.repos.webhooks.update(Number(id), body);
    if (!updated) throw notFound("Webhook");
    return updated;
  });

  app.delete("/api/v1/webhooks/:id", async (req) => {
    const { id } = req.params as { id: string };
    if (!ctx.repos.webhooks.delete(Number(id))) throw notFound("Webhook");
    return { ok: true };
  });

  app.post("/api/v1/webhooks/:id/test", async (req) => {
    const { id } = req.params as { id: string };
    const webhook = ctx.repos.webhooks.byId(Number(id));
    if (!webhook) throw notFound("Webhook");
    ctx.repos.webhooks.enqueue("listing.created", {
      title: "[TEST] Livraison webhook",
      priceCents: 1234500,
      url: "https://www.leboncoin.fr/",
      city: "Test",
      message: `Test manuel du webhook #${webhook.id}`,
    });
    if (ctx.outbox) await ctx.outbox.processOnce();
    return { ok: true, deliveries: ctx.repos.webhooks.deliveries(webhook.id, 5) };
  });

  app.get("/api/v1/webhooks/:id/deliveries", async (req) => {
    const { id } = req.params as { id: string };
    const webhook = ctx.repos.webhooks.byId(Number(id));
    if (!webhook) throw notFound("Webhook");
    return { deliveries: ctx.repos.webhooks.deliveries(webhook.id, 50) };
  });

  app.post("/api/v1/webhooks/deliveries/:id/replay", async (req) => {
    const { id } = req.params as { id: string };
    if (!ctx.repos.webhooks.replay(Number(id))) throw badRequest("Livraison introuvable ou non rejouable (statut failed/dead requis)");
    if (ctx.outbox) await ctx.outbox.processOnce();
    return { ok: true };
  });

  app.get("/api/v1/webhooks/:id/watches", async (req) => {
    const { id } = req.params as { id: string };
    const wh = ctx.repos.webhooks.byId(Number(id));
    if (!wh) throw notFound("Webhook");
    return { webhookId: wh.id, watchIds: ctx.repos.webhooks.watchIdsForWebhook(wh.id) };
  });

  app.put("/api/v1/webhooks/:id/watches", async (req) => {
    const { id } = req.params as { id: string };
    const wh = ctx.repos.webhooks.byId(Number(id));
    if (!wh) throw notFound("Webhook");
    const body = z.object({ watchIds: z.array(z.number().int()).default([]) }).parse(req.body);
    for (const wid of body.watchIds) if (!ctx.repos.watches.byId(wid)) throw badRequest(`Veille ${wid} introuvable`);
    ctx.repos.webhooks.setWebhookWatches(wh.id, body.watchIds);
    ctx.repos.audit.insert("webhook.watches", { webhookId: wh.id, watchIds: body.watchIds });
    return { webhookId: wh.id, watchIds: ctx.repos.webhooks.watchIdsForWebhook(wh.id) };
  });

  // Secret LLM + clé AnySolver + import/export de configuration
  app.post("/api/v1/system/llm-key", async (req) => {
    const body = z.object({ apiKey: z.string().min(10) }).parse(req.body);
    ctx.repos.secrets.set("llm_key", await ctx.vault.encrypt(body.apiKey));
    ctx.repos.audit.insert("llm.key_saved", {});
    return { ok: true };
  });
};
