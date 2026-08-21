import type { Bus } from "../bus.js";
import type { Delivery, Repos } from "../repos.js";
import { sendDiscord, DISCORD_COLORS } from "../adapters/discord/sender.js";
import { deliveryHeaders } from "../security/hmac.js";
import { logger } from "../logger.js";

/**
 * Outbox transactionnelle : les livraisons passent par webhook_deliveries,
 * jamais en direct. Reprises à +1 min, +5 min, +30 min, +2 h, puis dead-letter
 * avec rejeu manuel.
 */
export const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000];

export function nextAttemptAt(attempts: number, now = new Date()): Date | null {
  if (attempts >= RETRY_DELAYS_MS.length) return null; // → dead
  return new Date(now.getTime() + RETRY_DELAYS_MS[attempts]!);
}

export interface OutboxHandle {
  stop(): void;
  processOnce(): Promise<number>;
}

export function startOutbox(repos: Repos, bus: Bus, intervalMs = 30_000): OutboxHandle {
  let stopped = false;

  const deliver = async (d: Delivery): Promise<void> => {
    const target = repos.webhooks.deliveryPayload(d.id);
    if (!target) return;
    try {
      if (target.kind === "discord") {
        await sendDiscord(target.url, buildDiscordMessage(d.event, target.payload));
      } else {
        const secret = await repos.webhooks.secretOf(d.webhookId);
        const body = JSON.stringify(target.payload);
        const headers = secret
          ? deliveryHeaders(secret, d.event, body)
          : {
              "Content-Type": "application/json",
              "X-LBS-Event": d.event,
              "X-LBS-Delivery": String(d.id),
              "X-LBS-Timestamp": String(Math.floor(Date.now() / 1000)),
            };
        const res = await fetch(target.url, { method: "POST", headers, body });
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      }
      repos.webhooks.markDelivery(d.id, "delivered", d.attempts + 1, null, null);
      bus.publish("webhook.delivered", { deliveryId: d.id, event: d.event });
    } catch (err) {
      const e = err as Error;
      const next = nextAttemptAt(d.attempts);
      if (next === null) {
        repos.webhooks.markDelivery(d.id, "dead", d.attempts + 1, null, e.message);
        bus.publish("webhook.dead", { deliveryId: d.id, event: d.event, error: e.message });
      } else {
        repos.webhooks.markDelivery(d.id, "pending", d.attempts + 1, next.toISOString(), e.message);
      }
      logger.warn({ deliveryId: d.id, err: e.message }, "livraison webhook en échec");
    }
  };

  const loop = async () => {
    if (stopped) return;
    for (const d of repos.webhooks.dueDeliveries()) {
      if (stopped) break;
      await deliver(d);
    }
  };

  const timer = setInterval(() => void loop(), intervalMs);
  void loop();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    async processOnce() {
      const due = repos.webhooks.dueDeliveries();
      for (const d of due) await deliver(d);
      return due.length;
    },
  };
}

function buildDiscordMessage(event: string, payload: Record<string, unknown>) {
  const title = payload["title"] as string | undefined;
  const url = payload["url"] as string | undefined;
  const price = payload["priceCents"] as number | null | undefined;
  const fields: Array<{ name: string; value: string; inline: boolean }> = [];
  if (typeof price === "number") {
    fields.push({ name: "Prix", value: `${(price / 100).toFixed(2)} €`, inline: true });
  }
  if (payload["city"]) {
    fields.push({ name: "Ville", value: String(payload["city"]), inline: true });
  }
  if (payload["newPriceCents"] !== undefined && payload["newPriceCents"] !== null) {
    fields.push({ name: "Nouveau prix", value: `${(Number(payload["newPriceCents"]) / 100).toFixed(2)} €`, inline: true });
  }
  if (payload["previousPriceCents"] !== undefined && payload["previousPriceCents"] !== null) {
    fields.push({ name: "Ancien prix", value: `${(Number(payload["previousPriceCents"]) / 100).toFixed(2)} €`, inline: true });
  }
  const color =
    event === "listing.created" ? DISCORD_COLORS.created
    : event === "listing.price_changed" ? DISCORD_COLORS.priceDrop
    : event.includes("failed") || event.includes("dead") ? DISCORD_COLORS.error
    : DISCORD_COLORS.message;
  return {
    embeds: [
      {
        title: `[${event}] ${title ?? ""}`.trim(),
        url,
        description: payload["message"] ? String(payload["message"]) : undefined,
        color,
        fields,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}
