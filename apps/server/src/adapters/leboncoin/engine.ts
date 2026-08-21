import type { Listing, SearchSpec } from "@lbc/contracts";
import { fixtureWatch, allFixtures } from "@lbc/fixtures";
import type { Bus } from "../../bus.js";
import type { Repos } from "../../repos.js";
import { dealScore, localSort, relevanceScore } from "../../domain/scoring.js";
import { isJunkListing } from "../../domain/junk.js";
import type { LbcTransport } from "./transport.js";

export interface EngineRunResult {
  found: number;
  newCount: number;
  pageCount: number;
}

export interface SearchEngine {
  readonly kind: "fixtures" | "live";
  run(jobId: string, spec: SearchSpec, correlationId: string): Promise<EngineRunResult>;
}

/**
 * Engine fixtures — hors-ligne, déterministe. Filtre les annonces d'exemple,
 * score, déduplique en base, historise les prix, émet les événements.
 * Même contrat que l'engine live : un 403 upstream y deviendra une erreur
 * structurée (challenge ou quarantaine), jamais une liste vide.
 */
export class FixtureEngine implements SearchEngine {
  readonly kind = "fixtures" as const;

  constructor(
    private readonly repos: Repos,
    private readonly bus: Bus
  ) {}

  private filter(spec: SearchSpec, listings: Listing[]): Listing[] {
    let out = listings;
    if (spec.query.trim()) {
      const q = spec.query.toLowerCase();
      out = out.filter(
        (l) =>
          l.title.toLowerCase().includes(q) ||
          (l.body ?? "").toLowerCase().includes(q) ||
          (l.category ?? "").toLowerCase().includes(q)
      );
    }
    if (spec.priceCents?.min !== undefined) out = out.filter((l) => (l.priceCents ?? Infinity) >= spec.priceCents!.min!);
    if (spec.priceCents?.max !== undefined) out = out.filter((l) => (l.priceCents ?? 0) <= spec.priceCents!.max!);
    if (spec.ownerTypes?.length) out = out.filter((l) => spec.ownerTypes!.includes(l.owner?.type ?? "private"));
    if (spec.shippable) out = out.filter((l) => l.attributes["shippable"] === true);
    if (spec.locations?.departments?.length) {
      const deps = new Set(spec.locations.departments);
      out = out.filter((l) => !l.location?.department || deps.has(l.location.department));
    }
    return out.slice(0, spec.maxItems ?? 200);
  }

  async run(jobId: string, spec: SearchSpec, correlationId: string): Promise<EngineRunResult> {
    const pool = allFixtures();
    const filtered = this.filter(spec, pool);

    const scored = filtered.map((l) => ({
      ...l,
      score: relevanceScore(spec.query, l),
      source: "fixtures" as const,
    }));
    const prices = scored.map((l) => l.priceCents).filter((p): p is number => p !== undefined);
    let withDeal = scored.map((l) => ({
      ...l,
      dealScore: l.priceCents !== undefined ? dealScore(l.priceCents, prices) : undefined,
    }));
    // seuil bonne affaire : ne garde que les annonces assez sous la médiane
    if (spec.dealThreshold !== undefined) {
      withDeal = withDeal.filter((l) => (l.dealScore ?? -1) >= spec.dealThreshold!);
    }
    // anti-faux positifs déterministes — même règle que l'engine live
    if (spec.filterJunk !== false) {
      withDeal = withDeal.filter((l) => !isJunkListing(l));
    }

    const sorted = spec.localSort?.length ? (localSort(withDeal, spec.localSort) as typeof withDeal) : withDeal;

    const outcomes = this.repos.listings.upsertMany(sorted);
    let newCount = 0;
    for (const o of outcomes) {
      if (o.isNew) {
        newCount++;
        this.bus.publish("listing.created", {
          listingId: o.listing.id,
          title: o.listing.title,
          priceCents: o.listing.priceCents ?? null,
          jobId,
          correlationId,
        });
        this.repos.webhooks.enqueue("listing.created", {
          listingId: o.listing.id,
          title: o.listing.title,
          priceCents: o.listing.priceCents ?? null,
          url: o.listing.url,
          city: o.listing.location?.city ?? null,
        });
      } else if (o.priceChanged) {
        this.bus.publish("listing.price_changed", {
          listingId: o.listing.id,
          previousPriceCents: o.previousPriceCents,
          newPriceCents: o.listing.priceCents ?? null,
          jobId,
          correlationId,
        });
        this.repos.webhooks.enqueue("listing.price_changed", {
          listingId: o.listing.id,
          previousPriceCents: o.previousPriceCents,
          newPriceCents: o.listing.priceCents ?? null,
          title: o.listing.title,
          url: o.listing.url,
        });
      }
    }

    return { found: sorted.length, newCount, pageCount: Math.max(1, Math.ceil(sorted.length / 35)) };
  }
}

export { fixtureWatch };
