export const LBC_CATEGORIES: Record<string, string> = {
  "1": "Véhicules d'occasion",
  "2": "Voitures",
  "3": "Motos, scooters",
  "4": "Camping-cars, caravanes, vans",
  "5": "Utilitaires, fourgons",
  "6": "Pièces détachées auto",
  "7": "Nautisme",
  "8": "Immobilier",
  "9": "Ventes immobilières",
  "10": "Locations",
  "11": "Colocations",
  "12": "Locations saisonnières",
  "13": "Bureaux & commerces",
  "14": "Multimédia",
  "15": "Ordinateurs",
  "16": "Photo, audio & vidéo",
  "17": "Téléphones & objets connectés",
  "18": "Bricolage",
  "19": "Mobilier & meubles",
  "20": "Électroménager",
  "21": "Matériel & outils",
  "22": "Vêtements",
  "23": "Bébé & puériculture",
  "24": "Équipements de loisirs",
  "25": "DVD & blu-ray",
  "26": "Vinyles, CD, musique",
  "27": "Livres",
  "28": "Animaux",
  "29": "Sport & plein air",
  "30": "Instruments de musique",
  "31": "Services",
  "32": "Équipement industriel",
  "33": "Offres d'emploi",
};

/** Attributs de plage par catégorie — les plus utiles, vérifiés upstream. */
export const LBC_RANGE_ATTRIBUTES: Record<string, Array<{ key: string; label: string }>> = {
  immobilier: [
    { key: "square", label: "Surface (m²)" },
    { key: "rooms", label: "Pièces" },
  ],
  vehicules: [
    { key: "mileage", label: "Kilométrage" },
    { key: "regdate", label: "Année" },
  ],
};

export function rangeAttributesForCategory(categoryId?: string): Array<{ key: string; label: string }> {
  if (!categoryId) return [];
  if (["8", "9", "10", "11", "12", "13"].includes(categoryId)) return LBC_RANGE_ATTRIBUTES.immobilier!;
  if (["1", "2", "3", "4", "5"].includes(categoryId)) return LBC_RANGE_ATTRIBUTES.vehicules!;
  return [];
}
