import type { Listing, Message } from "@lbc/contracts";
import { allFixtures, fixtureConversations, fixtureWatch } from "@lbc/fixtures";
import type { Bus } from "./bus.js";
import type { Repos } from "./repos.js";

/**
 * Amorçage première exécution : annonces d'exemple (source fixtures),
 * conversations de démonstration, veille d'exemple. Ne touche rien si la base
 * contient déjà des données.
 */
export function seed(repos: Repos, bus: Bus): void {
  if (repos.listings.count() === 0) {
    repos.listings.upsertMany(allFixtures() as Listing[]);
    bus.publish("seed.listings", { count: allFixtures().length });
  }
  if (repos.conversations.count() === 0) {
    for (const { conversation, messages } of fixtureConversations) {
      repos.db.raw
        .prepare(
          `INSERT OR IGNORE INTO conversations
             (id, listing_id, listing_title, listing_price_cents, other_user, last_message_at, unread_count, classification)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          conversation.id,
          conversation.listingId,
          conversation.listingTitle,
          conversation.listingPriceCents,
          conversation.otherUser,
          conversation.lastMessageAt,
          conversation.unreadCount,
          conversation.classification
        );
      for (const m of messages) {
        repos.conversations.insertMessage(m as Message);
      }
    }
    bus.publish("seed.conversations", { count: fixtureConversations.length });
  }
  if (repos.watches.list().length === 0) {
    repos.watches.create(fixtureWatch.name, fixtureWatch.spec, fixtureWatch.cadenceMinutes);
  }
}
