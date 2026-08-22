import type { Conversation, Listing, Message, Watch } from "@lbc/contracts";

// ---------------------------------------------------------------------------
// PRNG déterministe (mulberry32) pour générer des volumes reproductibles
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function img(id: string, n: number): string[] {
  return Array.from(
    { length: n },
    (_, i) => `https://picsum.photos/seed/lbc-${id}-${i}/640/480`
  );
}

const now = () => new Date();
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

// ---------------------------------------------------------------------------
// Annonces écrites à la main — réalistes, variées, françaises
// ---------------------------------------------------------------------------

function L(
  id: string,
  title: string,
  priceCents: number,
  category: string,
  city: string,
  postalCode: string,
  ownerType: "private" | "pro",
  hAgo: number,
  body: string,
  extra: Partial<Listing> = {}
): Listing {
  return {
    id,
    url: `https://www.leboncoin.fr/ad/${category}/${id}.htm`,
    title,
    body,
    category,
    priceCents,
    publishedAt: hoursAgo(hAgo),
    scrapedAt: hoursAgo(hAgo - 0.1),
    location: { city, postalCode, department: postalCode.slice(0, 2) },
    owner: {
      type: ownerType,
      name: ownerType === "pro" ? `${city.replace(/-/g, " ")} Services` : undefined,
    },
    images: img(id, 3),
    attributes: {},
    score: 0,
    source: "fixtures",
    ...extra,
  };
}

export const handListings: Listing[] = [
  L("2841001", "Vélo route Triban RC 520 taille L - 2200 km", 64900, "velos", "Lyon 3e", "69003", "private", 2,
    "Vendu vélo route acheté neuf en 2023. 2 200 km environ, révision faite la semaine dernière. Cadre aluminium, fourche carbone, Shimano 105. Pneus neufs. Facture et notice. La taille L convient pour 1m78 - 1m85.", { attributes: { shippable: false } }),
  L("2841002", "iPhone 13 128 Go Bleu - batterie 89%", 38900, "telephonie", "Paris 11e", "75011", "private", 5,
    "iPhone 13 128 Go bleu, très bon état, aucune rayure. Batterie à 89%. Livré avec câble et coque. Facture disponible. Pas d'envoi, remise en main propre Paris 11e ou Bastille.", { owner: { type: "private", name: "Camille R." } }),
  L("2841003", "MacBook Air M2 13\" 8/256 - garantie jusqu'à 03/2027", 79900, "informatique", "Bordeaux", "33000", "private", 8,
    "MacBook Air M2 8 Go / 256 Go minuit. AppleCare+ jusqu'en mars 2027. 34 cycles de batterie. Boîte, câble original. Raison vente : passage sur MacBook Pro."),
  L("2841004", "Canapé 3 places en tissu gris - Linvisk", 24900, "maison", "Nantes", "44000", "private", 14,
    "Canapé 3 places IKEA, tissu gris clair, structure hêtre massif. Très bon état, non fumeur, pas d'animaux. Dimensions 218x88 cm. À récupuler sur place, étage avec ascenseur."),
  L("2841005", "PS5 Slim édition digitale + 2 manettes + 4 jeux", 42900, "jeux_video", "Toulouse", "31000", "private", 1,
    "Pack PS5 Slim digitale achetée en janvier. 2 manettes DualSense (une noire, une blanche), jeux : EA FC 25, Spider-Man 2, GT7, Elden Ring. Facture. Carton et câbles inclus."),
  L("2841006", "Vélo électrique Decathlon Riverside 520E cadre H", 89900, "velos", "Strasbourg", "67000", "private", 22,
    "VAE Riverside 520E, cadre homme, acheté 1 499€ neuf en 2022. 1 850 km au compteur. Batterie 418 Wh, autonomie constatée 70 km. Contrôle et révision Decathlon faits ce mois-ci. Casque et antivol offerts."),
  L("2841007", "Appartement T2 42m² Balma - balcon - parking", 15900000, "immobilier", "Balma", "31130", "pro", 3,
    "T2 de 42 m² au 2e étage avec ascenseur, balcon 6 m² sud, cuisine américaine équipée, parking en sous-sol. Résidence 2019, normes RT2012. Proche métro Balma-Gramont. Honoraires charge vendeur.", { owner: { type: "pro", name: "Agence Garonne Immobilier" } }),
  L("2841008", "Samsung Galaxy S24 256 Go Violet - comme neuf", 45500, "telephonie", "Lille", "59000", "private", 9,
    "Galaxy S24 256 Go violet, acheté en mars, sous garantie constructeur jusqu'en mars 2027. Écran parfait, coque et verre trempé depuis le premier jour. Toutes fonctions opérationnelles. Envoi possible Mondial Relay.", { attributes: { shippable: true } }),
  L("2841009", "Perceuse-visseuse Makita DHP484 + 2 batteries 5Ah", 24500, "bricolage", "Rennes", "35000", "private", 30,
    "Perceuse-visseuse Makita 18V brushless DHP484, deux batteries 5Ah, chargeur rapide, coffret MakPac. Utilisée pour un seul chantier. Mallette complète comme neuve."),
  L("2841010", "Vespa Primavera 125 - 2019 - 9 400 km", 289000, "motos", "Marseille", "13006", "private", 6,
    "Vespa Primavera 125 i-get de 2019, 9 400 km, toujours au garage, révisions chez concessionnaire. CT ok, aucun frais à prévoir. Deux casques + top case GTS inclus. Cylindre, freins, pneus neufs l'an dernier."),
  L("2841011", "Ensemble table + 4 chênes chêne massif", 55000, "maison", "Grenoble", "38000", "private", 44,
    "Table rectangulaire 160x90 en chêne massif huilé + 4 chaises cannées rétro. Achetées 1 250€ il y a trois ans. Quelques marques d'usage, photos réelles. Livraison possible sur Grenoble et alentours contre participation."),
  L("2841012", "Canon EOS R7 + RF 18-150 - 8 200 déclenchements", 129900, "photo", "Montpellier", "34000", "private", 12,
    "Canon EOS R7 avec objectif RF-S 18-150mm IS STM. 8 200 déclenchements seulement. Deux batteries LP-E6NHH, chargeur, sac Lowepro. Facture mai 2024. Garantie constructeur restante."),
  L("2841013", "Location saisonnière - Studio Carnon plage vue mer", 65000, "locations", "Carnon", "34280", "pro", 4,
    "Studio 24 m², 2e étage, vue mer directe, à 80 m de la plage. Kitchenette équipée, clim réversible, wifi fibre. Draps et serviettes fournis. Semaine du 12 au 19 juillet disponible. Taxe de séjour incluse."),
  L("2841014", "VTT électrique Rockrider E-ST 500 taille M", 115000, "velos", "Clermont-Ferrand", "63000", "private", 20,
    "VTTAE Decathlon E-ST 500, taille M, 27,5 pouces. 980 km. Batterie 522 Wh, moteur Brose. Révision complète (plaquettes, chaîne, pneus) chez Decathlon en avril. Chargeur, facture et clé batterie."),
  L("2841015", "Dyson V15 Detect Absolute - garanti 2 ans", 37900, "maison", "Nice", "06000", "private", 7,
    "Aspirateur balai Dyson V15 Detect Absolute, acheté 669€ en septembre. Garantie constructeur jusqu'en septembre 2026. Laser, tête Digital Motorbar, tous les accessoires d'origine dans la valise. Fonctionne parfaitement, raison : déménagement à l'étranger."),
  L("2841016", "Guitare électrique Fender Player Stratocaster Sunburst", 62000, "musique", "Reims", "51100", "private", 26,
    "Fender Player Stratocaster, finition Sunburst, manche érable. Achetée neuve 2022, jouée peu. Réglée par luthier le mois dernier, cordes neuves Ernie Ball 10-46. Housse Fender incluse. Pas d'ampli."),
  L("2841017", "Renault Clio 4 1.5 dCi 90 - 2017 - 118 000 km", 845000, "voitures", "Angers", "49000", "private", 16,
    "Clio 4 finition Zen, 1.5 dCi 90 ch, 118 000 km. Entretien à jour, distribution faite à 105 000 km chez Renault. CT jusqu'à fin 2026. Clim, Bluetooth, radar de recul. Intérieur propre, non fumeur. Carnet d'entretien complet."),
  L("2841018", "Écran LG UltraGear 27\" 1440p 165Hz", 22000, "informatique", "Tours", "37000", "private", 11,
    "Moniteur LG UltraGear 27GL850-B, 27 pouces, 2560x1440, 165 Hz, IPS 1ms. Aucun pixel mort ni rémanence. Pied original + câble DisplayPort. Raison de la vente : passage en 32 pouces.", { attributes: { shippable: true } }),
  L("2841019", "Machine à café Jura E8 - révisée", 65000, "maison", "Aix-en-Provence", "13100", "private", 34,
    "Machine à café automatique Jura E8 noir, 6 ans, révisée par un technicien agréé en février (groupe de percolation détartré, joints changés, 230€ de facture). Compteurs : 9 800 cafés. Buses vapeur neuves."),
  L("2841020", "Tondeuse robot Husqvarna Automower 310", 85000, "jardinage", "Versailles", "78000", "private", 48,
    "Robot tondeuse Husqvarna Automower 310, terrain jusqu'à 1000 m². 3 saisons d'usage, couteils et roues changés cette semaine. Batterie d'origine, autonomie correcte. Station, câbles périphériques et rails de guidage inclus. Manuel + clé."),
  L("2841021", "Nintendo Switch OLED blanche + 6 jeux", 29900, "jeux_video", "Besançon", "25000", "private", 2,
    "Switch OLED blanche, écran parfait, 6 jeux physiques : Zelda TOTK, Mario Kart 8, Metroid Dread, Animal Crossing, Mario Wonder, Smash Bros. Deux paires Joy-Con sans drift. Dock, pouch, 2 protections écran."),
  L("2841022", "Veste Barbour Bedale Waxed Olive - Taille 42", 18000, "mode", "Rouen", "76000", "private", 19,
    "Veste Barbour Bedale en coton ciré olive, taille 42 (M). Portée une saison, aucune déchirure. Doublure tartan intacte, fermetures éclair fonctionnelles. Cirée il y a un mois avec le produit Barbour d'origine.", { attributes: { shippable: true } }),
  L("2841023", "Bourse de cours - Cours particuliers maths/physique", 3500, "services", "Lyon 6e", "69006", "pro", 1,
    "Professeur certifié, 12 ans d'expérience, donne des cours de mathématiques et physique-chimie du collège au supérieur (prépa, L1-L2). Taux de réussite 96% au bac. Première séance d'évaluation offerte. En ligne ou à domicile.", { owner: { type: "pro", name: "Cours Particuliers Rhône" } }),
  L("2841024", "Baume du tigre rouge - lot de 3 pots 30g", 1500, "sante", "Paris 15e", "75015", "pro", 5,
    "Lot de 3 baumes du tigre rouge 30g, neuf et scellé. Date de péremption 04/2028. Envoi sous 24h, livraison suivie. Prix dégressif à partir de 5 lots.", { owner: { type: "pro", name: "Pharma Express" }, attributes: { shippable: true } }),
];

// ---------------------------------------------------------------------------
// Générateur de volume — reproductible, pour tester la virtualisation (5 000+)
// ---------------------------------------------------------------------------

const titleWords = {
  velo: ["Vélo route", "VTT", "Vélo ville", "Gravel", "Vélo course", "VAE"],
  brands: ["Triban", "Decathlon", "BTwin", "Cannondale", "Giant", "Specialized", "Cube", "Merida"],
  models: ["RC 520", "E-ST 500", "Riverside", "Ultimate", "Contend", "Touareg", "Axial", "Silette"],
  phone: ["iPhone 13", "iPhone 14", "Galaxy S23", "Galaxy S24", "Pixel 8", "Xiaomi 13T", "iPhone 12"],
  misc: ["table chêne", "canapé", "perceuse", "aspirateur", "écran 27\"", "MacBook Air", "PS5", "Switch OLED", "guitare", "enceinte", "appareil photo", "tondeuse"],
  cond: ["très bon état", "comme neuf", "bon état", "révisé", "garantie", "facture", "peu servi", "occasion"],
};

const cities: Array<[string, string]> = [
  ["Paris 11e", "75011"], ["Lyon 3e", "69003"], ["Marseille", "13006"], ["Bordeaux", "33000"],
  ["Lille", "59000"], ["Toulouse", "31000"], ["Nantes", "44000"], ["Strasbourg", "67000"],
  ["Montpellier", "34000"], ["Rennes", "35000"], ["Nice", "06000"], ["Angers", "49000"],
  ["Grenoble", "38000"], ["Dijon", "21000"], ["Reims", "51100"], ["Tours", "37000"],
];

export function generateListings(count: number, seed = 42): Listing[] {
  const rand = mulberry32(seed);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const out: Listing[] = [];
  for (let i = 0; i < count; i++) {
    const id = `gen${(9_000_000 + i).toString()}`;
    const [city, cp] = pick(cities);
    const kind = rand();
    let title: string;
    let category: string;
    let priceCents: number;
    if (kind < 0.35) {
      title = `${pick(titleWords.velo)} ${pick(titleWords.brands)} ${pick(titleWords.models)} ${pick(["taille S", "taille M", "taille L", "taille XL"])}`;
      category = "velos";
      priceCents = 20000 + Math.floor(rand() * 130000);
    } else if (kind < 0.6) {
      title = `${pick(titleWords.phone)} ${pick(["64 Go", "128 Go", "256 Go"])} ${pick(titleWords.cond)}`;
      category = "telephonie";
      priceCents = 12000 + Math.floor(rand() * 90000);
    } else {
      title = `${pick(titleWords.misc)} ${pick(titleWords.cond)}`;
      category = "maison";
      priceCents = 5000 + Math.floor(rand() * 150000);
    }
    const hAgo = rand() * 24 * 14; // dernières 2 semaines
    out.push({
      id,
      url: `https://www.leboncoin.fr/ad/${category}/${id}.htm`,
      title,
      body: `${title}. ${pick(titleWords.cond)}, non fumeur. Remise en main propre à ${city} ou envoi selon objet.`,
      category,
      priceCents,
      publishedAt: hoursAgo(hAgo),
      scrapedAt: hoursAgo(Math.max(0, hAgo - 0.2)),
      location: { city, postalCode: cp, department: cp.slice(0, 2) },
      owner: { type: rand() < 0.2 ? "pro" : "private" },
      images: img(id, 2),
      attributes: {},
      score: 0,
      source: "fixtures",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

function M(
  id: string,
  convId: string,
  direction: "in" | "out",
  senderName: string | null,
  body: string,
  hAgo: number
): Message {
  return {
    id,
    conversationId: convId,
    direction,
    senderId: direction === "in" ? `u-${senderName?.toLowerCase().replace(/[^a-z]/g, "")}` : "me",
    senderName: direction === "in" ? senderName : null,
    body,
    sentAt: hoursAgo(hAgo),
    auto: direction === "out" && hAgo < 3,
    deliveryStatus: "sent",
  };
}

export const fixtureConversations: Array<{ conversation: Conversation; messages: Message[] }> = [
  {
    conversation: {
      id: "conv-88121",
      listingId: "2841001",
      listingTitle: "Vélo route Triban RC 520 taille L - 2200 km",
      listingPriceCents: 64900,
      otherUser: "Karim B.",
      lastMessageAt: hoursAgo(1.2),
      unreadCount: 1,
      classification: "offre",
    },
    messages: [
      M("m-1", "conv-88121", "in", "Karim B.", "Bonjour, le vélo est toujours dispo ?", 26),
      M("m-2", "conv-88121", "out", null, "Bonjour, oui il est toujours disponible.", 25.5),
      M("m-3", "conv-88121", "in", "Karim B.", "Je vous le prends à 550€ si vous pouvez livrer vers Villeurbanne ce week-end ?", 1.2),
    ],
  },
  {
    conversation: {
      id: "conv-88144",
      listingId: "2841002",
      listingTitle: "iPhone 13 128 Go Bleu - batterie 89%",
      listingPriceCents: 38900,
      otherUser: "Sophie M.",
      lastMessageAt: hoursAgo(4),
      unreadCount: 2,
      classification: "question",
    },
    messages: [
      M("m-4", "conv-88144", "in", "Sophie M.", "Bonjour, est-ce que la facture est nominative ? Et l'écran a-t-il déjà été remplacé ?", 4.5),
      M("m-5", "conv-88144", "in", "Sophie M.", "Et est-ce que vous acceptez le paiement PayPal avec protection acheteur ?", 4),
    ],
  },
  {
    conversation: {
      id: "conv-88150",
      listingId: "2841005",
      listingTitle: "PS5 Slim édition digitale + 2 manettes + 4 jeux",
      listingPriceCents: 42900,
      otherUser: "Antoine P.",
      lastMessageAt: hoursAgo(22),
      unreadCount: 0,
      classification: "rendez-vous",
    },
    messages: [
      M("m-6", "conv-88150", "in", "Antoine P.", "Salut, je suis intéressé. Dispo demain vers 18h à Compans ?", 26),
      M("m-7", "conv-88150", "out", null, "Oui demain 18h ça marche. Je vous envoie l'adresse exacte le matin.", 25),
      M("m-8", "conv-88150", "in", "Antoine P.", "Parfait à demain.", 22),
    ],
  },
  {
    conversation: {
      id: "conv-88161",
      listingId: "2841006",
      listingTitle: "Vélo électrique Decathlon Riverside 520E cadre H",
      listingPriceCents: 89900,
      otherUser: "investpro92",
      lastMessageAt: hoursAgo(50),
      unreadCount: 0,
      classification: "spam",
    },
    messages: [
      M("m-9", "conv-88161", "in", "investpro92", "Bonjour je peux vous proposer 1200€ immédiatement par mandat, envoyez-moi vos coordonnées bancaires IBAN pour le virement urgent.", 50),
    ],
  },
  {
    conversation: {
      id: "conv-88177",
      listingId: "2841003",
      listingTitle: 'MacBook Air M2 13" 8/256 - garantie jusqu\'à 03/2027',
      listingPriceCents: 79900,
      otherUser: "Léa T.",
      lastMessageAt: hoursAgo(8),
      unreadCount: 1,
      classification: "question",
    },
    messages: [
      M("m-10", "conv-88177", "in", "Léa T.", "Bonjour, quel est le nombre de cycles exact de la batterie ? Est-elle encore sous AppleCare avec la couverture accidentelle ?", 8),
    ],
  },
];

// ---------------------------------------------------------------------------
// Veille d'exemple
// ---------------------------------------------------------------------------

export const fixtureWatch: Watch = {
  id: 1,
  name: "Vélos route — Rhône (69)",
  spec: {
    query: "vélo route",
    priceCents: { min: 30000, max: 120000 },
    locations: { departments: ["69"] },
    ownerTypes: ["private"],
    maxItems: 200,
    filterJunk: true,
    llmFilter: false,
  },
  enabled: true,
  cadenceMinutes: 10,
  lastRunAt: hoursAgo(9),
  lastStatus: "completed",
  createdAt: hoursAgo(24 * 7),
};

export function allFixtures(): Listing[] {
  return handListings;
}

export { now, hoursAgo };
