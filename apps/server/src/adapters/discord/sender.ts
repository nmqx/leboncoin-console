import { requestJson } from "../../security/http.js";

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordMessage {
  content?: string;
  embeds: Array<{
    title?: string;
    description?: string;
    url?: string;
    color?: number;
    fields?: DiscordEmbedField[];
    footer?: { text: string };
    timestamp?: string;
  }>;
}

/** Couleurs Discord (entiers) alignées sur les tokens de la console. */
export const DISCORD_COLORS = {
  created: 0x6db26d,      // lichen
  priceDrop: 0xd8b64a,    // ambre
  message: 0x6d9dd8,      // info
  error: 0xd86d5a,        // corail
} as const;

export class Discord429 extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Discord 429 — réessayer dans ${retryAfterMs} ms`);
    this.name = "Discord429";
  }
}

export class DiscordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordError";
  }
}

const TRUNCATE_AT = 380;

export function truncate(s: string, max = TRUNCATE_AT): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Envoi vers un webhook Discord. Le corps est tronqué par défaut (embeds).
 * 429 → Discord429 avec retry_after en ms (body JSON prioritaire, header en sec).
 */
export async function sendDiscord(
  webhookUrl: string,
  message: DiscordMessage,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await requestJson<unknown>(
    webhookUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...message,
        embeds: message.embeds.map((e) => ({
          ...e,
          description: e.description ? truncate(e.description) : undefined,
        })),
      }),
      timeoutMs: opts.timeoutMs ?? 10_000,
    },
    fetchImpl
  );
  if (res.status === 429) {
    const body = res.json as { retry_after?: number } | null;
    const retryAfterMs = body?.retry_after ? body.retry_after * 1000 : 1000;
    throw new Discord429(retryAfterMs);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new DiscordError(`Discord HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  }
}
