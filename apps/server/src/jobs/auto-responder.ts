import type { Bus } from "../bus.js";
import type { Repos } from "../repos.js";
import type { MessagingAdapter } from "../adapters/leboncoin/messaging.js";
import { LlmClient, REPLY_SYSTEM_PROMPT, validateReply } from "../adapters/llm/gemini.js";
import { logger } from "../logger.js";

/**
 * Pipeline automatique de messagerie (phase 10) :
 *   1. sync inbox (rejeu contrat v3) → nouvelles conversations → événements
 *   2. si automation activée + LLM configuré : pour chaque conversation dont
 *      le DERNIER message est entrant et sans réponse, générer un brouillon
 *      validé (JSON, bornes, zéro secret) et l'envoyer réellement.
 *
 * Garde-fous (les mêmes que la route manuelle) : 10/h/conversation,
 * 100/jour, jamais de premier contact, classification spam → pas d'envoi,
 * idempotence par dedupeKey auto-<id dernier message entrant>.
 */
export class AutoResponder {
  private busy = false;
  /** Le « pas de session » n'est journalisé qu'une fois, pas à chaque tick. */
  private inboxUnavailableLogged = false;

  constructor(
    private readonly deps: {
      repos: Repos;
      messaging: MessagingAdapter;
      getLlm(): Promise<{ baseUrl: string; apiKey: string; model: string } | null>;
      bus: Bus;
    }
  ) {}

  async syncOnly(): Promise<{ synced: number; created: number; error?: string; skipped?: string }> {
    try {
      const items = await this.deps.messaging.fetchConversations();
      let created = 0;
      for (const { conversation, links } of items) {
        const { isNew } = this.deps.repos.conversations.upsertLive(conversation, links);
        if (isNew) {
          created++;
          this.deps.bus.publish("message.received", {
            conversationId: conversation.id,
            otherUser: conversation.otherUser,
            listingTitle: conversation.listingTitle,
          });
          this.deps.repos.webhooks.enqueue("message.received", {
            conversationId: conversation.id,
            otherUser: conversation.otherUser,
            listingTitle: conversation.listingTitle,
            unreadCount: conversation.unreadCount,
          });
        }
      }
      return { synced: items.length, created };
    } catch (err) {
      const msg = (err as Error).message;
      const code = (err as Error & { code?: string }).code;
      // Pas de compte connecté / pas de contrat capturé n'est PAS une panne :
      // la messagerie est une fonction à part, la veille tourne sans compte.
      // On le dit une fois, puis on se tait — sinon le log tourne en boucle à
      // chaque tick et noie les vraies erreurs.
      if (code === "no_session" || code === "no_captured_contract") {
        if (!this.inboxUnavailableLogged) {
          this.inboxUnavailableLogged = true;
          logger.info({ code }, "messagerie inactive (aucune session Leboncoin) — veilles non affectées");
        }
        return { synced: 0, created: 0, skipped: code };
      }
      this.inboxUnavailableLogged = false;
      logger.warn({ err: msg }, "auto-sync inbox échouée");
      return { synced: 0, created: 0, error: msg };
    }
  }

  async processAndReply(automationEnabled: boolean): Promise<{
    synced: number;
    created: number;
    replied: number;
    skipped: string[];
    error?: string;
  }> {
    const sync = await this.syncOnly();
    const skipped: string[] = [];
    if (!automationEnabled) {
      skipped.push("automation désactivée");
      return { ...sync, replied: 0, skipped };
    }
    const llm = await this.deps.getLlm();
    if (!llm) {
      skipped.push("LLM non configuré");
      return { ...sync, replied: 0, skipped };
    }
    if (this.busy) {
      skipped.push("pipeline déjà en cours");
      return { ...sync, replied: 0, skipped };
    }
    this.busy = true;
    let replied = 0;
    try {
      const client = new LlmClient({ baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model });
      const conversations = this.deps.repos.conversations.list();

      for (const conv of conversations) {
        // cible : compteur non lus > 0 (l'amont dit qu'il y a du neuf entrant)
        if (conv.unreadCount <= 0) continue;
        // limites strictes
        if (this.deps.repos.conversations.countRecentHour(conv.id) >= 10) {
          skipped.push(`${conv.otherUser}: limite horaire`);
          continue;
        }
        if (this.deps.repos.conversations.countOutboxToday() >= 100) {
          skipped.push("limite quotidienne globale");
          break;
        }

        let messages;
        try {
          messages = await this.deps.messaging.fetchMessages(conv.id, this.deps.repos.conversations.linksOf(conv.id));
        } catch (err) {
          skipped.push(`${conv.otherUser}: messages indisponibles (${(err as Error).message.slice(0, 60)})`);
          continue;
        }
        // persistance idempotente du thread
        for (const m of messages) {
          if (m.conversationId === conv.id) this.deps.repos.conversations.insertMessage(m);
        }
        const last = messages[messages.length - 1];
        if (!last || last.direction !== "in") continue; // jamais de premier contact

        // brouillon LLM avec contexte annonce
        const listing = conv.listingId ? this.deps.repos.listings.byId(conv.listingId) : undefined;
        const facts = [
          listing ? `Annonce : ${listing.title}` : `Annonce : ${conv.listingTitle ?? "inconnue"}`,
          conv.listingPriceCents ? `Prix affiché : ${(conv.listingPriceCents / 100).toFixed(2)} €` : null,
          `Acheteur : ${conv.otherUser}`,
        ]
          .filter(Boolean)
          .join("\n");
        const turns = messages.slice(-6).map((m) => ({
          role: (m.direction === "in" ? "user" : "assistant") as "user" | "assistant",
          content: m.body,
        }));

        let draft;
        try {
          const raw = await client.complete(`${REPLY_SYSTEM_PROMPT}\n\n${facts}`, turns);
          draft = validateReply(raw, { forbiddenSubstrings: [llm.apiKey] });
        } catch (err) {
          skipped.push(`${conv.otherUser}: brouillon invalide (${(err as Error).message.slice(0, 60)})`);
          this.deps.repos.webhooks.enqueue("reply.failed", {
            conversationId: conv.id, otherUser: conv.otherUser, reason: (err as Error).message.slice(0, 120),
          });
          this.deps.bus.publish("reply.failed", { conversationId: conv.id, reason: (err as Error).message.slice(0, 120) });
          continue;
        }
        if (draft.classification === "spam") {
          skipped.push(`${conv.otherUser}: classé spam — pas d'envoi`);
          this.deps.repos.audit.insert("reply.spam_skipped", { conversationId: conv.id });
          continue;
        }

        try {
          await this.deps.messaging.sendMessage(conv.id, draft.reply, this.deps.repos.conversations.linksOf(conv.id));
          this.deps.repos.conversations.insertMessage({
            id: `auto-${last.id}`.slice(0, 60),
            conversationId: conv.id,
            direction: "out",
            senderId: "me",
            senderName: null,
            body: draft.reply,
            sentAt: new Date().toISOString(),
            auto: true,
            deliveryStatus: "sent",
          });
          replied++;
          this.deps.repos.audit.insert("reply.auto_sent", {
            conversationId: conv.id, otherUser: conv.otherUser, classification: draft.classification,
          });
          this.deps.bus.publish("reply.sent", { conversationId: conv.id, auto: true });
          this.deps.repos.webhooks.enqueue("reply.sent", {
            conversationId: conv.id, otherUser: conv.otherUser,
            listingTitle: conv.listingTitle, auto: true, body: draft.reply.slice(0, 200),
          });
        } catch (err) {
          skipped.push(`${conv.otherUser}: envoi échoué (${(err as Error).message.slice(0, 60)})`);
          this.deps.repos.webhooks.enqueue("reply.failed", {
            conversationId: conv.id, otherUser: conv.otherUser, reason: (err as Error).message.slice(0, 120),
          });
          this.deps.bus.publish("reply.failed", { conversationId: conv.id, reason: (err as Error).message.slice(0, 120) });
        }
      }
    } finally {
      this.busy = false;
    }
    if (replied > 0 || skipped.length > 0) {
      logger.info({ replied, skipped: skipped.length }, "auto-responder terminé");
    }
    return { ...sync, replied, skipped };
  }
}
