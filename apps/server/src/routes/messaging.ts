import { z } from "zod";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AppCtx } from "./types.js";
import { notFound, AppError } from "../security/errors.js";
import { LlmClient, REPLY_SYSTEM_PROMPT, validateReply, LlmError, ReplyValidationError } from "../adapters/llm/gemini.js";
import { MessagingAdapter, MessagingError } from "../adapters/leboncoin/messaging.js";
import type { Message } from "@lbc/contracts";

export const messagingRoutes = (app: FastifyInstance, ctx: AppCtx, messaging?: MessagingAdapter): void => {
  app.get("/api/v1/conversations", async () => {
    return { conversations: ctx.repos.conversations.list() };
  });

  app.get("/api/v1/conversations/:id", async (req) => {
    const { id } = req.params as { id: string };
    const conv = ctx.repos.conversations.byId(id);
    if (!conv) throw notFound("Conversation");
    let messages = ctx.repos.conversations.messages(id);

    // Mode live : thread vide en base → rejeu du contrat HAL pour le remplir
    if (messages.length === 0 && messaging && ctx.cfg.LBC_MODE === "live") {
      try {
        const live = await messaging.fetchMessages(id, ctx.repos.conversations.linksOf(id));
        for (const m of live) {
          if (m.conversationId === id) ctx.repos.conversations.insertMessage(m);
        }
        messages = ctx.repos.conversations.messages(id);
      } catch { // contrat absent ou échec upstream : la base reste la vérité
      }
    }
    const listing = conv.listingId ? ctx.repos.listings.byId(conv.listingId) : undefined;
    return { conversation: conv, messages, listing: listing ?? null };
  });

  const ReplyBody = z.object({
    body: z.string().min(1).max(2000),
    dedupeKey: z.string().optional(),
    auto: z.boolean().default(false),
  });

  /**
   * Sync inbox live : rejeu du contrat capturé, merge HAL → base, événements.
   * Routing messagerie indépendant (défaut : direct, IP du compte).
   */
  app.post("/api/v1/conversations/sync", async () => {
    if (!messaging) throw new AppError("live_disabled", "Sync live requiert LBC_MODE=live", { status: 409 });
    let items;
    try {
      items = await messaging.fetchConversations();
    } catch (err) {
      if (err instanceof MessagingError) {
        throw new AppError(err.code, err.message, { status: 502, retryable: true });
      }
      throw err;
    }
    let created = 0;
    for (const { conversation, links } of items) {
      const { isNew } = ctx.repos.conversations.upsertLive(conversation, links);
      if (isNew) {
        created++;
        ctx.bus.publish("message.received", {
          conversationId: conversation.id,
          otherUser: conversation.otherUser,
          listingTitle: conversation.listingTitle,
        });
        ctx.repos.webhooks.enqueue("message.received", {
          conversationId: conversation.id,
          otherUser: conversation.otherUser,
          listingTitle: conversation.listingTitle,
          unreadCount: conversation.unreadCount,
        });
      }
    }
    return { ok: true, synced: items.length, created };
  });

  app.post("/api/v1/conversations/:id/reply", async (req) => {
    const { id } = req.params as { id: string };
    const body = ReplyBody.parse(req.body);
    const conv = ctx.repos.conversations.byId(id);
    if (!conv) throw notFound("Conversation");

    // Idempotence d'abord : même dedupeKey déjà envoyé → retour de l'existant,
    // sans consommer les limites ni subir le débounce.
    const messageId = body.dedupeKey
      ? `out-${createHash("sha256").update(`${id}:${body.dedupeKey}`).digest("hex").slice(0, 24)}`
      : `out-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    if (body.dedupeKey) {
      const existing = ctx.repos.conversations.messages(id).find((m) => m.id === messageId);
      if (existing) return { inserted: false, message: existing };
    }

    // Kill switch : arrêt total, technique, immédiat.
    if (ctx.repos.settings.get("kill_switch") === "1") {
      throw new AppError("kill_switch", "Kill switch actif — aucun envoi", { status: 423 });
    }
    // Les réponses automatiques exigent l'automation activée ; la manuelle passe.
    if (body.auto && ctx.repos.settings.get("automation_enabled") !== "1") {
      throw new AppError("automation_disabled", "Automation désactivée", { status: 409 });
    }

    // Limites strictes : 10/h/conversation, 100/jour, debounce 20 s.
    const hourly = ctx.repos.conversations.countRecentHour(id);
    if (hourly >= ctx.cfg.replyLimits.perHourPerConversation) {
      throw new AppError("rate_limited", `Limite horaire atteinte pour cette conversation (${hourly}/10)`, { status: 429, retryable: true });
    }
    const daily = ctx.repos.conversations.countOutboxToday();
    if (daily >= ctx.cfg.replyLimits.perDay) {
      throw new AppError("daily_limit", `Limite quotidienne atteinte (${daily}/100)`, { status: 429 });
    }
    const messages = ctx.repos.conversations.messages(id);
    const lastOut = [...messages].reverse().find((m) => m.direction === "out");
    if (lastOut && Date.now() - Date.parse(lastOut.sentAt) < ctx.cfg.replyLimits.debounceSeconds * 1000) {
      throw new AppError("debounce", `Débounce ${ctx.cfg.replyLimits.debounceSeconds}s en cours`, { status: 429, retryable: true });
    }

    // Envoi réel en mode live : rejeu du contrat capturé. Échec → erreur
    // structurée, jamais de faux « envoyé ».
    let deliveryStatus: Message["deliveryStatus"] = ctx.cfg.LBC_MODE === "live" ? "pending" : "simulated";
    if (ctx.cfg.LBC_MODE === "live" && messaging) {
      try {
        const links = ctx.repos.conversations.linksOf(id);
        await messaging.sendMessage(id, body.body, links);
        deliveryStatus = "sent";
      } catch (err) {
        if (err instanceof MessagingError) {
          throw new AppError(err.code, err.message, { status: 502, retryable: true });
        }
        throw err;
      }
    }

    const message: Message = {
      id: messageId,
      conversationId: id,
      direction: "out",
      senderId: "me",
      senderName: null,
      body: body.body,
      sentAt: new Date().toISOString(),
      auto: body.auto,
      deliveryStatus,
    };
    const { inserted, message: final } = ctx.repos.conversations.insertMessage(message);

    if (inserted) {
      ctx.repos.audit.insert("reply.sent", { conversationId: id, messageId, auto: body.auto, simulated: ctx.cfg.LBC_MODE !== "live" });
      ctx.bus.publish("reply.sent", { conversationId: id, messageId, auto: body.auto, simulated: message.deliveryStatus === "simulated" });
      ctx.repos.webhooks.enqueue("reply.sent", {
        conversationId: id,
        otherUser: conv.otherUser,
        listingTitle: conv.listingTitle,
        auto: body.auto,
        body: body.body.slice(0, 200),
      });
    }
    return { inserted, message: final };
  });

  /** Aperçu LLM : génère un brouillon validé, ne l'envoie pas. */
  app.post("/api/v1/conversations/:id/preview-reply", async (req) => {
    const { id } = req.params as { id: string };
    const conv = ctx.repos.conversations.byId(id);
    if (!conv) throw notFound("Conversation");
    const apiKey = await ctx.llmApiKey();
    if (!apiKey || !ctx.cfg.LLM_BASE_URL) {
      throw new AppError("llm_not_configured", "LLM non configuré (clé + base URL) — écran Système", { status: 409 });
    }

    const messages = ctx.repos.conversations.messages(id);
    const listing = conv.listingId ? ctx.repos.listings.byId(conv.listingId) : undefined;
    const facts = [
      listing ? `Annonce : ${listing.title}` : `Annonce : ${conv.listingTitle ?? "inconnue"}`,
      conv.listingPriceCents ? `Prix affiché : ${(conv.listingPriceCents / 100).toFixed(2)} €` : null,
      `[CONTEXTE_CONFIGURÉ]`,
    ]
      .filter(Boolean)
      .join("\n");

    const turns = [
      ...messages.slice(-6).map((m) => ({
        role: (m.direction === "in" ? "user" : "assistant") as "user" | "assistant",
        content: m.body,
      })),
    ];

    const client = new LlmClient({ baseUrl: ctx.cfg.LLM_BASE_URL, apiKey, model: ctx.cfg.LLM_MODEL });
    try {
      const raw = await client.complete(`${REPLY_SYSTEM_PROMPT}\n\n${facts}`, turns);
      const draft = validateReply(raw, { forbiddenSubstrings: [apiKey] });
      return { draft, raw };
    } catch (err) {
      if (err instanceof LlmError || err instanceof ReplyValidationError) {
        throw new AppError(err.name, err.message, { status: 502, retryable: err instanceof LlmError ? err.retryable : false });
      }
      throw err;
    }
  });
};
