import { describe, it, expect } from "vitest";
import { isJunkListing, filterJunk } from "../../apps/server/src/domain/junk.js";
import { parseRelevanceResponse, filterByRelevance, RELEVANCE_SYSTEM_PROMPT } from "../../apps/server/src/adapters/llm/gemini.js";

describe("anti-faux positifs déterministes", () => {
  it("≤ 1 € = appât", () => {
    expect(isJunkListing({ title: "PS5", priceCents: 100 })?.[0]).toBeTruthy();
    expect(isJunkListing({ title: "PS5", priceCents: 0 })).toBeTruthy();
    expect(isJunkListing({ title: "PS5", priceCents: 200 })).toBeNull();
    expect(isJunkListing({ title: "PS5" })).toBeNull();
  });

  it("échange/troc/don dans le titre = pas une vente", () => {
    expect(isJunkListing({ title: "Vélo route — échange contre scooter", priceCents: 20000 })).toMatch(/échange/);
    expect(isJunkListing({ title: "Troc iPhone contre Samsung", priceCents: 50000 })).toBeTruthy();
    expect(isJunkListing({ title: "Don chattes adultes", priceCents: undefined })).toBeTruthy();
    // faux positif légitime : « donne » (verbe) ne matche pas
    expect(isJunkListing({ title: "Vélo de route donne satisfaction", priceCents: 30000 })).toBeNull();
    // trade-off assumé : « don » comme mot du titre = junk, même noyé dans
    // une vente réelle (ex. coussins gratuits avec un canapé)
    expect(isJunkListing({ title: "Canapé (possibilité de don de coussins)", priceCents: 15000 })).toBeTruthy();
  });

  it("filterJunk sépare proprement", () => {
    const { kept, junked } = filterJunk([
      { title: "Vrai vélo", priceCents: 30000 },
      { title: "Vélo 1€", priceCents: 100 },
      { title: "Échange vélo", priceCents: 30000 },
    ]);
    expect(kept).toHaveLength(1);
    expect(junked).toHaveLength(2);
  });
});

describe("filtre LLM de pertinence", () => {
  it("parse la réponse keep: [numéros]", () => {
    const keep = parseRelevanceResponse('{"keep":[1,3]}', 4);
    expect([...keep].sort()).toEqual([1, 3]);
  });

  it("tolère code fences, tableau nu, chaînes", () => {
    expect([...parseRelevanceResponse('```json\n{"keep":[2]}\n```', 3)]).toEqual([2]);
    expect([...parseRelevanceResponse("[1]", 2)]).toEqual([1]);
    expect([...parseRelevanceResponse('{"keep":["1","2"]}', 2)].sort()).toEqual([1, 2]);
  });

  it("réponse illisible ou vide → tout conservé (jamais bloquant)", () => {
    expect(parseRelevanceResponse("n'importe quoi", 3).size).toBe(3);
    expect(parseRelevanceResponse('{"keep":[]}', 3).size).toBe(3);
    expect(parseRelevanceResponse('{"keep":[99]}', 3).size).toBe(3);
  });

  it("filterByRelevance garde tout si l'appel échoue", async () => {
    const out = await filterByRelevance("switch", [{ id: "a", title: "x" }], async () => {
      throw new Error("llm down");
    });
    expect(out.applied).toBe(false);
    expect(out.keptIds.has("a")).toBe(true);
  });

  it("filterByRelevance applique la sélection", async () => {
    const out = await filterByRelevance(
      "console nintendo switch",
      [
        { id: "a", title: "Nintendo Switch OLED", priceCents: 25000 },
        { id: "b", title: "Just Dance - Nintendo Switch", priceCents: 800 },
      ],
      async () => '{"keep":[1]}'
    );
    expect(out.applied).toBe(true);
    expect(out.keptIds.has("a")).toBe(true);
    expect(out.keptIds.has("b")).toBe(false);
  });

  it("le prompt cible explicitement le piège jeu/plateforme", () => {
    expect(RELEVANCE_SYSTEM_PROMPT).toMatch(/Just Dance/);
  });
});
