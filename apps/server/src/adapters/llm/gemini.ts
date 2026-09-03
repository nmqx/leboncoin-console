import { requestJson, type RequestOptions } from "../../security/http.js";

// ---------------------------------------------------------------------------
// Client OpenAI-compatible (gateway 34.155.17.195:8045, modèle gemini-3.7-flash-high)
//   POST {LLM_BASE_URL}/v1/chat/completions
//   Authorization: Bearer <clé>
// ATTENTION : transport HTTP public accepté par l'opérateur — bandeau permanent
// dans l'interface. Jamais de secret dans le prompt.
// ---------------------------------------------------------------------------

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface LlmTurn {
  role: "user" | "assistant";
  content: string;
}

interface ChatCompletionsResponse {
  choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  error?: { type?: string; message?: string };
}

export class LlmError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "LlmError";
  }
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export class LlmClient {
  private readonly cfg: LlmConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: LlmConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = { maxTokens: 512, temperature: 0.3, timeoutMs: 15_000, ...cfg };
    this.fetchImpl = fetchImpl;
  }

  async complete(system: string, turns: LlmTurn[]): Promise<string> {
    const opts: RequestOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        max_tokens: this.cfg.maxTokens,
        temperature: this.cfg.temperature,
        messages: [{ role: "system", content: system }, ...turns],
      }),
      timeoutMs: this.cfg.timeoutMs,
    };
    const res = await requestJson<ChatCompletionsResponse>(
      `${normalizeBaseUrl(this.cfg.baseUrl)}/v1/chat/completions`,
      opts,
      this.fetchImpl
    );
    if (res.status === 429 || res.status >= 500) {
      throw new LlmError(`LLM HTTP ${res.status}`, true);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new LlmError(`LLM HTTP ${res.status}: ${res.json?.error?.message ?? res.text.slice(0, 200)}`, false);
    }
    const content = res.json?.choices?.[0]?.message?.content;
    const text = (typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((c) => c.type !== "image" && typeof c.text === "string").map((c) => c.text!).join("\n")
        : ""
    ).trim();
    if (!text) throw new LlmError("Réponse LLM vide", true);
    return text;
  }
}

// ---------------------------------------------------------------------------
// Validation de la réponse : JSON strict, bornes, zéro secret
// ---------------------------------------------------------------------------

export interface ReplyDraft {
  reply: string;
  classification: "question" | "offre" | "rendez-vous" | "spam" | "autre" | null;
  confidence: number;
}

export class ReplyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyValidationError";
  }
}

export function validateReply(
  raw: string,
  opts: { maxLen?: number; forbiddenSubstrings?: string[] } = {}
): ReplyDraft {
  const maxLen = opts.maxLen ?? 500;
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new ReplyValidationError("La réponse LLM n'est pas du JSON valide");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ReplyValidationError("La réponse LLM n'est pas un objet");
  }
  const obj = parsed as Record<string, unknown>;
  const reply = obj["reply"];
  if (typeof reply !== "string" || reply.trim().length === 0) {
    throw new ReplyValidationError("Champ 'reply' absent ou vide");
  }
  if (reply.length > maxLen) {
    throw new ReplyValidationError(`Réponse trop longue (${reply.length} > ${maxLen})`);
  }
  for (const secret of opts.forbiddenSubstrings ?? []) {
    if (secret && (reply.includes(secret) || stripped.includes(secret))) {
      throw new ReplyValidationError("La réponse contient un élément secret — rejet");
    }
  }
  const classificationRaw = obj["classification"];
  const allowed = ["question", "offre", "rendez-vous", "spam", "autre"] as const;
  const classification =
    typeof classificationRaw === "string" && (allowed as readonly string[]).includes(classificationRaw)
      ? (classificationRaw as ReplyDraft["classification"])
      : null;
  const confidenceRaw = obj["confidence"];
  const confidence =
    typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : 0.5;
  return { reply: reply.trim(), classification, confidence };
}

export const REPLY_SYSTEM_PROMPT = `Tu es l'assistant de vente d'un particulier sur Leboncoin.
Tu réponds aux messages reçus à propos de l'annonce fournie. Règles strictes :
- Réponds en français, courtois, concret, 1 à 4 phrases maximum.
- Reste strictement sur le sujet de l'annonce : titre, prix, état, disponibilité, remise en main propre.
- Ne partage jamais de coordonnées bancaires, d'IBAN, de lien de paiement, ni de données personnelles autres que la ville.
- N'accepte jamais un paiement à distance ni d'envoi avant rencontre sauf si [ENVOI_AUTORISE] est présent.
- Si la demande semble frauduleuse (surenchère urgente, mandat, PayPal ami), classe-la "spam" et refuse poliment.
Réponds UNIQUEMENT en JSON: {"reply": string, "classification": "question"|"offre"|"rendez-vous"|"spam"|"autre", "confidence": number}`;

// ---------------------------------------------------------------------------
// Filtre sémantique anti-faux positifs — UN appel groupé par run de recherche
// ---------------------------------------------------------------------------

export interface RelevanceCandidate {
  id: string;
  title: string;
  priceCents?: number;
}

export const RELEVANCE_SYSTEM_PROMPT = `Tu filtres les résultats d'une recherche Leboncoin avec une rigueur absolue.
On te donne une requête (ce que l'opérateur cherche VRAIMENT) et une liste numérotée d'annonces (titre + prix).
Règles strictes :
- Une annonce est PERTINENTE seulement si l'objet principal vendu EST EXACTEMENT l'appareil cherché.
- CARTES GRAPHIQUES (GPU : RTX, GTX, Radeon...) :
  * L'objet VENDU doit être la carte graphique fonctionnelle complète et en état de marche.
  * REJETER STRICTEMENT tout matériel défectueux, HS, en panne, pour pièces, sans dissipateur / sans ventirad, ou incomplet.
  * REJETER STRICTEMENT tout accessoire : waterblock, bloc watercooling, bloc de refroidissement, backplate, ventilateur seul, boîte vide, carton, riser, support vertical, pont SLI, câble.
  * REJETER STRICTEMENT les annonces de recherche / achat (ex: « Cherche RTX 3090 » ou « Recherche GPU »).
  * REJETER STRICTEMENT les modèles ou déclinaisons différentes :
    - Si la requête est « RTX 2080 Ti », une RTX 2080 standard ou une RTX 2080 Super N'EST PAS une 2080 Ti → REJET IMMÉDIAT.
    - Si la requête est « RTX 3080 », une RTX 3070 ou 3090 N'EST PAS une 3080 → REJET IMMÉDIAT.
- TÉLÉPHONES / CONSOLES / AUTRES : coque, étui, protection écran, verre trempé, film, écran de remplacement, batterie, câble, chargeur, adaptateur, support, housse, sticker, manette seule = REJET IMMÉDIAT.
- L'appareil d'une GÉNÉRATION DIFFÉRENTE n'est pas l'appareil cherché : « Pixel 8a » ou « Pixel 9 » pour une requête « pixel 8 » est NON pertinent ; seul « Pixel 8 » (éventuellement Pro) l'est.
- Une annonce ambiguë, accessoire ou hors-sujet est NON pertinente.
Réponds UNIQUEMENT en JSON: {"keep": [numéros des annonces pertinentes]}`;

/** Parse la réponse du filtre : tolérant (code fences, numéros, chaîne ou tableau). */
export function parseRelevanceResponse(raw: string, total: number): Set<number> {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return allKept(total); // réponse illisible → on garde tout (jamais bloquant)
  }
  const keepRaw =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { keep?: unknown }).keep)
      ? (parsed as { keep: unknown[] }).keep
      : Array.isArray(parsed)
        ? parsed
        : null;
  if (!keepRaw) return allKept(total);
  const keep = new Set<number>();
  for (const v of keepRaw) {
    const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9]/g, ""));
    if (Number.isInteger(n) && n >= 1 && n <= total) keep.add(n);
  }
  // Si le LLM a explicitement retourné un tableau vide, c'est que rien n'est pertinent !
  return keep;
}

function allKept(total: number): Set<number> {
  return new Set(Array.from({ length: total }, (_, i) => i + 1));
}

/**
 * Filtre les annonces par pertinence sémantique. Un seul appel pour tout le
 * lot. En cas d'échec LLM : tout est conservé (le filtre ne bloque jamais la
 * recherche), l'appelant est informé via le booléen retourné.
 */
export async function filterByRelevance(
  query: string,
  candidates: RelevanceCandidate[],
  complete: (system: string, turns: LlmTurn[]) => Promise<string>
): Promise<{ keptIds: Set<string>; applied: boolean }> {
  if (candidates.length === 0) return { keptIds: new Set(), applied: true };
  const list = candidates
    .map((c, i) => `${i + 1}. [id=${c.id}] ${c.title} — ${c.priceCents !== undefined ? `${(c.priceCents / 100).toFixed(0)} €` : "prix non précisé"}`)
    .join("\n");
  try {
    const raw = await complete(RELEVANCE_SYSTEM_PROMPT, [
      { role: "user", content: `Requête : « ${query} »\n\nAnnonces :\n${list}` },
    ]);
    const keep = parseRelevanceResponse(raw, candidates.length);
    const keptIds = new Set(candidates.filter((_, i) => keep.has(i + 1)).map((c) => c.id));
    return { keptIds, applied: true };
  } catch {
    return { keptIds: new Set(candidates.map((c) => c.id)), applied: false };
  }
}
