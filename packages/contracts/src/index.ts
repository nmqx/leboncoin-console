import { z } from "zod";

export * from "./categories.js";

// ---------------------------------------------------------------------------
// Recherche
// ---------------------------------------------------------------------------

export const SearchSpecSchema = z.object({
  query: z.string().min(1).max(200),
  categoryIds: z.array(z.string()).optional(),
  adTypes: z.array(z.enum(["offer", "demand"])).optional(),
  priceCents: z
    .object({
      min: z.number().int().nonnegative().optional(),
      max: z.number().int().nonnegative().optional(),
    })
    .refine((p) => p.min === undefined || p.max === undefined || p.min <= p.max, {
      message: "priceCents.min doit être <= priceCents.max",
    })
    .optional(),
  locations: z
    .object({
      departments: z.array(z.string()).optional(),
      postalCodes: z.array(z.string()).optional(),
      lat: z.number().optional(),
      lon: z.number().optional(),
      radiusKm: z.number().positive().max(500).optional(),
    })
    .optional(),
  ownerTypes: z.array(z.enum(["private", "pro"])).optional(),
  shippable: z.boolean().optional(),
  urgent: z.boolean().optional(),
  /** Attributs dynamiques : valeur {min,max} → paramètre de plage (square=20-80),
   *  valeur scalaire ou tableau → enum (furnished=1). Clés = noms Leboncoin. */
  attributes: z.record(z.unknown()).optional(),
  maxItems: z.number().int().positive().max(1000).default(10),
  /** Seuil de bonne affaire [0–0,95] : ne garde que les annonces au moins
   *  aussi sous la médiane (dealScore >= seuil). 0,3 = « top 30 % ». */
  dealThreshold: z.number().min(0).max(0.95).optional(),
  /** Anti-faux positifs déterministes : exclut ≤ 1 € et échange/troc/don. */
  filterJunk: z.boolean().default(true),
  /** Filtre LLM des faux positifs sémantiques (ex. un jeu au lieu de la
   *  console cherchée) — un seul appel groupé par run, clé LLM requise. */
  llmFilter: z.boolean().optional(),
  localSort: z
    .array(
      z.object({
        field: z.enum(["relevance", "publishedAt", "price", "distance"]),
        direction: z.enum(["asc", "desc"]),
      })
    )
    .optional(),
});
export type SearchSpec = z.infer<typeof SearchSpecSchema>;

// ---------------------------------------------------------------------------
// Annonce
// ---------------------------------------------------------------------------

export const ListingSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  body: z.string().optional(),
  category: z.string().optional(),
  priceCents: z.number().int().optional(),
  publishedAt: z.string().optional(),
  scrapedAt: z.string(),
  location: z
    .object({
      city: z.string().optional(),
      postalCode: z.string().optional(),
      department: z.string().optional(),
    })
    .optional(),
  owner: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      type: z.enum(["private", "pro"]).optional(),
    })
    .optional(),
  images: z.array(z.string()),
  attributes: z.record(z.unknown()),
  score: z.number(),
  dealScore: z.number().optional(),
  source: z.enum(["authorized-api", "authorized-web", "import", "fixtures"]),
});
export type Listing = z.infer<typeof ListingSchema>;

export const PricePointSchema = z.object({
  priceCents: z.number().int(),
  observedAt: z.string(),
});
export type PricePoint = z.infer<typeof PricePointSchema>;

// ---------------------------------------------------------------------------
// Jobs et veilles
// ---------------------------------------------------------------------------

export const SearchJobStatus = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "quarantined",
]);
export type SearchJobStatus = z.infer<typeof SearchJobStatus>;

export const SearchJobSchema = z.object({
  id: z.string(),
  watchId: z.number().int().nullable(),
  status: SearchJobStatus,
  pageCount: z.number().int().nullable(),
  itemsFound: z.number().int().nullable(),
  itemsNew: z.number().int().nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    })
    .nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  correlationId: z.string(),
});
export type SearchJob = z.infer<typeof SearchJobSchema>;

export const WatchSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  spec: SearchSpecSchema,
  enabled: z.boolean(),
  cadenceMinutes: z.number().int().min(1).max(1440),
  lastRunAt: z.string().nullable(),
  lastStatus: z.string().nullable(),
  createdAt: z.string(),
});
export type Watch = z.infer<typeof WatchSchema>;

// ---------------------------------------------------------------------------
// Messagerie
// ---------------------------------------------------------------------------

export const MessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  direction: z.enum(["in", "out"]),
  senderId: z.string().nullable(),
  senderName: z.string().nullable(),
  body: z.string(),
  sentAt: z.string(),
  auto: z.boolean(),
  deliveryStatus: z.enum(["sent", "pending", "failed", "simulated"]).nullable(),
});
export type Message = z.infer<typeof MessageSchema>;

export const ConversationSchema = z.object({
  id: z.string(),
  listingId: z.string().nullable(),
  listingTitle: z.string().nullable(),
  listingPriceCents: z.number().int().nullable(),
  otherUser: z.string(),
  lastMessageAt: z.string(),
  unreadCount: z.number().int(),
  classification: z.enum(["question", "offre", "rendez-vous", "spam", "autre"]).nullable(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export const EventNameSchema = z.enum([
  "listing.created",
  "listing.price_changed",
  "watch.completed",
  "message.received",
  "reply.sent",
  "reply.failed",
  "challenge.failed",
  "session.expiring",
]);
export type EventName = z.infer<typeof EventNameSchema>;

export const WebhookKindSchema = z.enum(["discord", "http"]);
export type WebhookKind = z.infer<typeof WebhookKindSchema>;

export const WebhookSchema = z.object({
  id: z.number().int(),
  kind: WebhookKindSchema,
  url: z.string(),
  hasSecret: z.boolean(),
  enabled: z.boolean(),
  events: z.array(EventNameSchema),
  createdAt: z.string(),
});
export type Webhook = z.infer<typeof WebhookSchema>;

export const DeliveryStatusSchema = z.enum(["pending", "delivered", "failed", "dead"]);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

export const DeliverySchema = z.object({
  id: z.number().int(),
  webhookId: z.number().int(),
  event: EventNameSchema,
  status: DeliveryStatusSchema,
  attempts: z.number().int(),
  nextAttemptAt: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
});
export type Delivery = z.infer<typeof DeliverySchema>;

// ---------------------------------------------------------------------------
// Session et statut
// ---------------------------------------------------------------------------

export const SessionStatusSchema = z.object({
  imported: z.boolean(),
  userId: z.string().nullable(),
  userAgent: z.string().nullable(),
  expiresAt: z.string().nullable(),
  expiresSoon: z.boolean(),
  mode: z.enum(["fixtures", "live"]),
});
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const StatusSchema = z.object({
  version: z.string(),
  uptimeSeconds: z.number(),
  mode: z.enum(["fixtures", "live"]),
  scheduler: z.object({
    running: z.boolean(),
    nextRunAt: z.string().nullable(),
  }),
  automation: z.object({
    enabled: z.boolean(),
    killSwitch: z.boolean(),
  }),
  counters: z.object({
    listings: z.number().int(),
    watches: z.number().int(),
    conversations: z.number().int(),
    pendingDeliveries: z.number().int(),
  }),
});
export type Status = z.infer<typeof StatusSchema>;

// ---------------------------------------------------------------------------
// Erreur commune
// ---------------------------------------------------------------------------

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    correlationId: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

export const SseEventSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  payload: z.record(z.unknown()),
  createdAt: z.string(),
});
export type SseEvent = z.infer<typeof SseEventSchema>;
