import { describe, it, expect, vi } from "vitest";
import { LlmClient, validateReply, ReplyValidationError, normalizeBaseUrl, REPLY_SYSTEM_PROMPT } from "../../apps/server/src/adapters/llm/gemini.js";

function okResponse(text: string) {
  return new Response(
    JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] }),
    { status: 200 }
  );
}

describe("LlmClient (OpenAI-compatible)", () => {
  it("POST {base}/v1/chat/completions avec Authorization Bearer et rôle system", async () => {
    const fn = vi.fn(async () => okResponse("pong")) as unknown as typeof fetch;
    const client = new LlmClient({ baseUrl: "http://llm.local", apiKey: "sk-1", model: "gemini-3.7-flash-high" }, fn);
    const out = await client.complete("system", [{ role: "user", content: "ping" }]);
    expect(out).toBe("pong");
    const call = (fn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("http://llm.local/v1/chat/completions");
    const headers = call[1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-1");
    expect(headers["x-api-key"]).toBeUndefined();
    const body = JSON.parse(call[1].body as string);
    expect(body.model).toBe("gemini-3.7-flash-high");
    expect(body.max_tokens).toBe(512);
    expect(body.temperature).toBeCloseTo(0.3);
    expect(body.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "ping" },
    ]);
  });

  it("base URL avec /v1 ou slashs finaux → normalisée sans double chemin", () => {
    expect(normalizeBaseUrl("http://x/")).toBe("http://x");
    expect(normalizeBaseUrl("http://x/v1")).toBe("http://x");
    expect(normalizeBaseUrl("http://x/v1/")).toBe("http://x");
  });

  it("HTTP 500 → LlmError retryable ; réponse vide → erreur", async () => {
    const fail = vi.fn(async () => new Response("boom", { status: 502 })) as unknown as typeof fetch;
    const client = new LlmClient({ baseUrl: "http://x", apiKey: "k", model: "m" }, fail);
    await expect(client.complete("s", [{ role: "user", content: "u" }])).rejects.toMatchObject({ retryable: true });

    const empty = vi.fn(async () => okResponse("")) as unknown as typeof fetch;
    const client2 = new LlmClient({ baseUrl: "http://x", apiKey: "k", model: "m" }, empty);
    await expect(client2.complete("s", [{ role: "user", content: "u" }])).rejects.toThrow(/vide/);
  });
});

describe("validateReply", () => {
  it("JSON propre → brouillon validé", () => {
    const d = validateReply('{"reply":"Bonjour, oui disponible.","classification":"question","confidence":0.9}');
    expect(d.reply).toBe("Bonjour, oui disponible.");
    expect(d.classification).toBe("question");
    expect(d.confidence).toBeCloseTo(0.9);
  });

  it("accepte les code fences ```json", () => {
    const d = validateReply('```json\n{"reply":"ok"}\n```');
    expect(d.reply).toBe("ok");
    expect(d.classification).toBeNull();
    expect(d.confidence).toBe(0.5);
  });

  it("rejette JSON invalide, reply vide, trop long", () => {
    expect(() => validateReply("pas du json")).toThrow(ReplyValidationError);
    expect(() => validateReply('{"reply":""}')).toThrow(/absent ou vide/);
    expect(() => validateReply(`{"reply":"${"a".repeat(501)}"}`)).toThrow(/trop longue/);
  });

  it("rejette toute fuite de secret", () => {
    expect(() =>
      validateReply('{"reply":"ma clé est sk-SECRET-123"}', { forbiddenSubstrings: ["sk-SECRET-123"] })
    ).toThrow(/secret/);
  });

  it("borne la confiance et filtre les classifications inconnues", () => {
    const d = validateReply('{"reply":"ok","classification":"nimporte","confidence":7}');
    expect(d.classification).toBeNull();
    expect(d.confidence).toBe(1);
  });

  it("le prompt système interdit les données bancaires et les paiements à distance", () => {
    expect(REPLY_SYSTEM_PROMPT).toMatch(/IBAN/);
    expect(REPLY_SYSTEM_PROMPT).toMatch(/JSON/);
  });
});
