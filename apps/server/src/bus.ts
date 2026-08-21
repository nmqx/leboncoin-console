import { EventEmitter } from "node:events";
import type { SseEvent } from "@lbc/contracts";
import type { EventsRepo } from "./repos.js";

/**
 * Bus d'événements : persiste (events) et diffuse (SSE + listeners internes).
 */
export class Bus {
  private readonly emitter = new EventEmitter();
  private readonly sseClients = new Set<(e: SseEvent) => void>();

  constructor(private readonly events: EventsRepo) {
    this.emitter.setMaxListeners(100);
  }

  publish(type: string, payload: Record<string, unknown>): SseEvent {
    const event = this.events.insert(type, payload);
    this.emitter.emit("event", event);
    for (const send of this.sseClients) {
      try {
        send(event);
      } catch {
        this.sseClients.delete(send);
      }
    }
    return event;
  }

  subscribe(listener: (e: SseEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  addSseClient(send: (e: SseEvent) => void): () => void {
    this.sseClients.add(send);
    return () => this.sseClients.delete(send);
  }
}
