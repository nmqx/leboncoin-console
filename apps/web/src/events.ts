import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SseEvent } from "@lbc/contracts";

/**
 * Flux SSE /api/v1/events : dernier événement exposé à la barre d'état,
 * invalidations ciblées selon le type (les tables se rafraîchissent seules).
 */
export function useEvents() {
  const qc = useQueryClient();
  const [last, setLast] = useState<SseEvent | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource("/api/v1/events");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as SseEvent;
        setLast(parsed);
        switch (parsed.type) {
          case "listing.created":
          case "listing.price_changed":
            void qc.invalidateQueries({ queryKey: ["listings"] });
            break;
          case "watch.completed":
          case "watch.started":
            void qc.invalidateQueries({ queryKey: ["watches"] });
            void qc.invalidateQueries({ queryKey: ["listings"] });
            break;
          case "reply.sent":
          case "message.received":
          case "seed.conversations":
            void qc.invalidateQueries({ queryKey: ["conversations"] });
            void qc.invalidateQueries({ queryKey: ["conversation"] });
            break;
          case "webhook.delivered":
          case "webhook.dead":
            void qc.invalidateQueries({ queryKey: ["webhooks"] });
            void qc.invalidateQueries({ queryKey: ["deliveries"] });
            break;
          case "search.completed":
          case "search.failed":
            void qc.invalidateQueries({ queryKey: ["listings"] });
            void qc.invalidateQueries({ queryKey: ["status"] });
            break;
          default:
            void qc.invalidateQueries({ queryKey: ["status"] });
        }
      } catch {
        // heartbeat ou format inattendu : ignoré
      }
    };
    return () => es.close();
  }, [qc]);

  return { last, connected };
}
