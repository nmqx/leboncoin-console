import { describe, it, expect } from "vitest";
import { normalizeAd, parseSearchResponse, buildSearchPayload, buildSearchUrl, dateFromParis } from "../../apps/server/src/adapters/leboncoin/live.js";
import { classifyDataDome } from "../../apps/server/src/adapters/leboncoin/datadome.js";

// Forme réelle observée dans la réponse finder/search (cat. 10)
const realAd = {
  list_id: 3227792905,
  first_publication_date: "2026-07-05 10:39:51",
  index_date: "2026-07-05 10:39:51",
  status: "active",
  category_id: "10",
  category_name: "Locations",
  subject: "STUDIO étudiant moderne Grenoble, parking gratuit",
  body: "",
  ad_type: "offer",
  url: "https://www.leboncoin.fr/ad/locations/3227792905",
  price_cents: 53500,
  price: [[535]],
  images: {
    urls: [
      "https://img.leboncoin.fr/api/v1/lbcpb1/images/d4/7f/3b/a.jpg?rule=ad-image",
      "https://img.leboncoin.fr/api/v1/lbcpb1/images/1b/2d/6a/b.jpg?rule=ad-image",
    ],
  },
  attributes: [
    { key: "rating_score", value: "0.97", value_label: "0.97" },
    { key: "real_estate_type", value: "2", value_label: "Appartement" },
  ],
  location: {
    city: "Grenoble", zipcode: "38100", department_id: "38", department_name: "Isère",
    region_name: "Rhône-Alpes", lat: 45.16, lng: 5.72,
  },
  owner: { store_id: "5786511", user_id: "269c5a64", type: "private", name: "Jocelyn" },
};

describe("normalizeAd — payload réel Leboncoin", () => {
  it("mappe tous les champs du contrat Listing", () => {
    const l = normalizeAd(realAd as never, "2026-08-21T12:00:00Z");
    expect(l.id).toBe("3227792905");
    expect(l.title).toContain("STUDIO");
    expect(l.priceCents).toBe(53500);
    expect(l.category).toBe("Locations");
    expect(l.source).toBe("authorized-web");
    expect(l.location).toEqual({ city: "Grenoble", postalCode: "38100", department: "38" });
    expect(l.owner).toEqual({ id: "269c5a64", name: "Jocelyn", type: "private" });
    expect(l.images).toHaveLength(2);
    expect(l.attributes["real_estate_type"]).toBe("Appartement"); // value_label privilégié
    expect(l.url).toBe(realAd.url);
    expect(l.publishedAt).toBeDefined();
  });

  it("fallback prix via price[][] quand price_cents absent", () => {
    const l = normalizeAd({ ...realAd, price_cents: undefined, price: [[740]] } as never);
    expect(l.priceCents).toBe(74000);
  });

  it("images en tableau plat acceptées, owner pro mappé, body vide → undefined", () => {
    const l = normalizeAd({
      ...realAd,
      images: ["https://img.leboncoin.fr/x.jpg"],
      owner: { type: "pro", name: "POLE HABITAT", store_id: "1" },
    } as never);
    expect(l.images).toEqual(["https://img.leboncoin.fr/x.jpg"]);
    expect(l.owner?.type).toBe("pro");
    expect(l.body).toBeUndefined();
  });

  it("dates Paris converties en ISO UTC (heure d'été +2)", () => {
    const iso = dateFromParis("2026-07-05 10:39:51");
    expect(iso).toBe("2026-07-05T08:39:51.000Z");
    // hiver : +1
    expect(dateFromParis("2026-01-15 10:39:51")).toBe("2026-01-15T09:39:51.000Z");
    expect(dateFromParis("garbage")).toBeUndefined();
  });
});

describe("finder/search", () => {
  it("extrait ads, total et max_pages de la réponse API", () => {
    const r = parseSearchResponse(JSON.stringify({ ads: [realAd], total: 143, max_pages: 5 }));
    expect(r.ads).toHaveLength(1);
    expect(r.total).toBe(143);
    expect(r.maxPages).toBe(5);
  });

  it("réponse sans ads → erreur de schéma explicite (jamais vide silencieux)", () => {
    expect(() => parseSearchResponse(JSON.stringify({ total: 0 }))).toThrow(/sans tableau ads/);
  });

  it("construit le payload API actuel avec pagination et filtres", () => {
    const payload = buildSearchPayload({
      query: "rtx 3090",
      categoryIds: ["15"],
      priceCents: { min: 30_000, max: 120_000 },
      ownerTypes: ["private"],
      locations: { departments: ["44", "75"] },
      shippable: true,
      urgent: true,
      attributes: { brand: ["apple", "samsung"], square: { min: 20, max: 80 } },
      maxItems: 200,
    }, 3);
    expect(payload.sort_by).toBe("time");
    expect(payload.offset).toBe(70);
    expect(payload.limit).toBe(35);
    expect(payload.owner_type).toBe("private");
    expect(payload.filters.category).toEqual({ id: "15" });
    expect(payload.filters.ranges?.price).toEqual({ min: 300, max: 1200 });
    expect(payload.filters.ranges?.square).toEqual({ min: 20, max: 80 });
    expect(payload.filters.enums).toMatchObject({ ad_type: ["offer"], urgent: ["1"], brand: ["apple", "samsung"] });
    expect(payload.filters.location).toEqual({
      shippable: true,
      locations: [
        { locationType: "department", department_id: "44" },
        { locationType: "department", department_id: "75" },
      ],
    });
  });
});

describe("buildSearchUrl", () => {
  it("paramètres validés : text, category, price, tri date desc, numéro de page", () => {
    const url = new URL(buildSearchUrl({ query: "vélo route", categoryIds: ["4"], priceCents: { min: 30000, max: 120000 }, maxItems: 200 }, 2));
    expect(url.searchParams.get("text")).toBe("vélo route");
    expect(url.searchParams.get("category")).toBe("4");
    expect(url.searchParams.get("price")).toBe("300-1200");
    // contrat actuel : `date` fait répondre 503, `time` est le tri chronologique
    expect(url.searchParams.get("sort")).toBe("time");
    expect(url.searchParams.get("order")).toBe("desc");
    // `page` est le numéro de page (vérifié live, fenêtres disjointes) — pas `o`
    expect(url.searchParams.get("page")).toBe("2");
  });

  it("requête par défaut «toutes annonces» → pas de paramètre text, page 1 sans page", () => {
    const url = new URL(buildSearchUrl({ query: "toutes annonces", maxItems: 50 }, 1));
    expect(url.searchParams.has("text")).toBe(false);
    expect(url.searchParams.has("page")).toBe(false);
  });
});

describe("classifier DataDome — variantes observées en production", () => {
  it("403 API réelle : /interstitial/ + t=it (pas de rt=i)", () => {
    const body = JSON.stringify({
      url: "https://geo.captcha-delivery.com/interstitial/?initialCid=x&cid=y&referer=z&hash=h&t=it&s=285&e=abc&b=1865789",
    });
    const c = classifyDataDome({ status: 403, url: "https://api.leboncoin.fr/api/search/v1/search", body });
    expect(c?.kind).toBe("interstitial");
    expect(c?.cookieName).toBe("DataDomeInterstitialCookie");
  });

  it("rt=c → slider ; t=bv → abandon", () => {
    expect(
      classifyDataDome({ status: 403, url: "https://geo.captcha-delivery.com/captcha/?rt=c&hash=1" })?.kind
    ).toBe("slider");
    expect(
      classifyDataDome({ status: 403, url: "https://geo.captcha-delivery.com/captcha/?t=bv" })?.kind
    ).toBe("abandon");
  });
});
