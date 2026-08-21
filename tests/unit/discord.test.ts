import { describe, it, expect, vi } from "vitest";
import { sendDiscord, Discord429, truncate, DISCORD_COLORS } from "../../apps/server/src/adapters/discord/sender.js";

describe("sendDiscord", () => {
  it("payload en embeds, description tronquée par défaut", async () => {
    const fn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      expect(body.embeds).toHaveLength(1);
      expect(body.embeds[0].description.length).toBeLessThanOrEqual(381); // 380 + ellipsis
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await sendDiscord("https://discord.com/api/webhooks/x/y", {
      embeds: [{ title: "Nouvelle annonce", description: "x".repeat(1000), color: DISCORD_COLORS.created }],
    }, { fetchImpl: fn });
    expect(fn).toHaveBeenCalledOnce();
  });

  it("429 avec retry_after → Discord429 en ms", async () => {
    const fn = vi.fn(async () =>
      new Response(JSON.stringify({ retry_after: 2.5 }), { status: 429 })
    ) as unknown as typeof fetch;
    await expect(
      sendDiscord("https://discord.com/api/webhooks/x/y", { embeds: [] }, { fetchImpl: fn })
    ).rejects.toMatchObject({ name: "Discord429", retryAfterMs: 2500 });
  });

  it("HTTP 500 → DiscordError", async () => {
    const fn = vi.fn(async () => new Response("oops", { status: 500 })) as unknown as typeof fetch;
    await expect(
      sendDiscord("https://discord.com/api/webhooks/x/y", { embeds: [] }, { fetchImpl: fn })
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("truncate", () => {
  it("court inchangé, long coupé avec ellipse", () => {
    expect(truncate("abc")).toBe("abc");
    const long = truncate("a".repeat(400));
    expect(long.length).toBe(380);
    expect(long.endsWith("…")).toBe(true);
  });
});
