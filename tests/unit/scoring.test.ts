import { describe, it, expect } from "vitest";
import { relevanceScore, median, dealScore, localSort, dedupe, tokenize } from "../../apps/server/src/domain/scoring.js";
import type { Listing } from "@lbc/contracts";

const mk = (over: Partial<Listing> & { id: string }): Listing => ({
  url: `https://www.leboncoin.fr/ad/${over.id}.htm`,
  title: "",
  images: [],
  attributes: {},
  score: 0,
  scrapedAt: "2026-08-21T10:00:00Z",
  source: "fixtures",
  ...over,
});

describe("tokenize FR", () => {
  it("plie les accents et retire les stopwords", () => {
    expect(tokenize("Vélo ROUTE très bon état")).toEqual(["velo", "route", "bon", "etat"]);
  });
});

describe("relevanceScore", () => {
  it("titre ×3 domine corps ×1", () => {
    const inTitle = relevanceScore("vélo route", mk({ id: "1", title: "Vélo route Triban", body: "", category: "" }));
    const inBody = relevanceScore("vélo route", mk({ id: "2", title: "Annonce", body: "contient vélo route ici", category: "" }));
    expect(inTitle).toBe(1);
    expect(inBody).toBeLessThan(1);
    expect(inBody).toBeGreaterThan(0);
  });

  it("requête vide → 0", () => {
    expect(relevanceScore("", mk({ id: "3", title: "x" }))).toBe(0);
  });
});

describe("median / dealScore", () => {
  it("médiane paire et impaire", () => {
    expect(median([100, 200, 300])).toBe(200);
    expect(median([100, 200, 300, 400])).toBe(250);
    expect(median([])).toBeNull();
  });

  it("bonne affaire = sous la médiane, borné ±1", () => {
    expect(dealScore(100, [100, 200, 300])).toBeCloseTo(0.5, 5);
    expect(dealScore(300, [100, 200, 300])).toBeCloseTo(-0.5, 5);
    expect(dealScore(0, [100])).toBe(1);
    expect(dealScore(100, [])).toBeUndefined();
  });
});

describe("localSort", () => {
  const a = mk({ id: "a", priceCents: 500, publishedAt: "2026-08-01T00:00:00Z", score: 0.9 });
  const b = mk({ id: "b", priceCents: 200, publishedAt: "2026-08-10T00:00:00Z", score: 0.4 });
  const c = mk({ id: "c" }); // sans prix ni date

  it("prix asc/desc, nulls en dernier", () => {
    const asc = localSort([a, b, c], [{ field: "price", direction: "asc" }]);
    expect(asc.map((x) => x.id)).toEqual(["b", "a", "c"]);
    const desc = localSort([a, b, c], [{ field: "price", direction: "desc" }]);
    expect(desc.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("nouveauté d'abord", () => {
    const recents = localSort([a, b], [{ field: "publishedAt", direction: "desc" }]);
    expect(recents.map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("pertinence desc", () => {
    expect(localSort([b, a], [{ field: "relevance", direction: "desc" }])[0]!.id).toBe("a");
  });
});

describe("dedupe", () => {
  const existing = [
    mk({ id: "1", title: "ancien", scrapedAt: "2026-08-01T00:00:00Z", priceCents: 1000, images: ["a"] }),
  ];

  it("nouveau → isNew, aucune collision", () => {
    const out = dedupe(existing, [mk({ id: "2", title: "nouveau" })]);
    expect(out[0]!.isNew).toBe(true);
    expect(out).toHaveLength(1);
  });

  it("même id plus récent → fusion, images union, prix suivis", () => {
    const out = dedupe(existing, [
      mk({ id: "1", title: "rafraîchi", scrapedAt: "2026-08-20T00:00:00Z", priceCents: 800, images: ["b"] }),
    ]);
    expect(out[0]!.isNew).toBe(false);
    expect(out[0]!.priceChanged).toBe(true);
    expect(out[0]!.previousPriceCents).toBe(1000);
    expect(out[0]!.listing.images).toEqual(["a", "b"]);
    expect(out[0]!.listing.title).toBe("rafraîchi");
  });

  it("même id plus vieux → l'existant garde la main", () => {
    const out = dedupe(existing, [
      mk({ id: "1", title: "périmé", scrapedAt: "2026-07-01T00:00:00Z", priceCents: 1200 }),
    ]);
    expect(out[0]!.listing.title).toBe("ancien");
    expect(out[0]!.priceChanged).toBe(true);
  });
});
