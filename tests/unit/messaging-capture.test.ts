import { describe, it, expect } from "vitest";
import { classifyCaptured } from "../../apps/server/src/repos.js";
import {
  extractConversations, nextHalLink, normalizeConversation, buildReplayRequest,
} from "../../apps/server/src/adapters/leboncoin/messaging.js";
import type { CapturedRequest } from "../../apps/server/src/repos.js";

describe("classification des requêtes capturées", () => {
  it("inbox / send / api selon méthode et chemin", () => {
    expect(classifyCaptured("GET", "/messaging/proxy/api/v1/hal/123/conversations")).toBe("inbox");
    expect(classifyCaptured("POST", "/messaging/proxy/api/v1/hal/123/conversations/456/messages")).toBe("send");
    expect(classifyCaptured("PUT", "/messaging/api/v2/conversation/9")).toBe("send");
    expect(classifyCaptured("GET", "/api/advert/v1/123")).toBe("api");
    expect(classifyCaptured("GET", "/favicon.ico")).toBe("other");
  });

  it("le bruit temps réel n'est JAMAIS un envoi (bug du message détourné)", () => {
    expect(classifyCaptured("POST", "/messaging/proxy/api/v1/hal/u/conversations/c/realtime/typing?typingStatus=true")).toBe("other");
    expect(classifyCaptured("POST", "/messaging/proxy/api/hal/u/realtime/credentials")).toBe("other");
    expect(classifyCaptured("PUT", "/messaging/proxy/api/v1/hal/u/conversations/c/messages/m/read")).toBe("other");
  });
});

describe("extraction HAL tolérante", () => {
  it("_embedded['conversation-list'], tableau nu, clé conversations", () => {
    expect(extractConversations({ _embedded: { "conversation-list": [{ id: 1 }] } })).toHaveLength(1);
    expect(extractConversations([{ id: 2 }])).toHaveLength(1);
    expect(extractConversations({ conversations: [{ id: 3 }] })).toHaveLength(1);
    expect(extractConversations({ rien: true })).toHaveLength(0);
    expect(extractConversations(null)).toHaveLength(0);
  });

  it("nextHalLink lit _links.next", () => {
    expect(nextHalLink({ _links: { next: { href: "/page2" } } })).toBe("/page2");
    expect(nextHalLink({ _links: { self: { href: "/x" } } })).toBeNull();
    expect(nextHalLink({})).toBeNull();
  });

  it("normalizeConversation mappe les dialectes courants", () => {
    const { conversation, links } = normalizeConversation({
      id: "abc-1",
      listing_id: 2841001,
      ad: { subject: "Vélo route", price: { amount: 649 } },
      user: { username: "Karim B." },
      date: "2026-08-21T10:00:00.000Z",
      unread_count: 2,
      _links: { self: { href: "https://www.leboncoin.fr/messaging/x" }, messages: { href: "https://www.leboncoin.fr/messaging/y" } },
    });
    expect(conversation.id).toBe("abc-1");
    expect(conversation.listingId).toBe("2841001");
    expect(conversation.listingTitle).toBe("Vélo route");
    expect(conversation.listingPriceCents).toBe(64900);
    expect(conversation.otherUser).toBe("Karim B.");
    expect(conversation.unreadCount).toBe(2);
    expect(links["messages"]).toContain("/messaging/y");
  });

  it("user en chaîne et prix plat acceptés", () => {
    const { conversation } = normalizeConversation({ id: 7, user: "Lea", ad: { price: 120 } });
    expect(conversation.otherUser).toBe("Lea");
    expect(conversation.listingPriceCents).toBe(12000);
  });
});

describe("rejeu des requêtes capturées", () => {
  const captured: CapturedRequest = {
    id: 1,
    method: "GET",
    url: "https://www.leboncoin.fr/messaging/proxy/api/v1/hal/42/conversations?presenceStatus=true",
    host: "www.leboncoin.fr",
    path: "/messaging/proxy/api/v1/hal/42/conversations",
    status: 200,
    requestHeaders: {
      "User-Agent": "UA-chrome",
      Accept: "application/json",
      // jamais rejoués :
      Cookie: "luat=secret; datadome=zzz",
      "Content-Length": "0",
      Host: "www.leboncoin.fr",
    },
    cookieNames: ["luat", "datadome"],
    postData: null,
    kind: "inbox",
    capturedAt: "2026-08-21T10:00:00Z",
  };

  it("mêmes en-têtes sûrs, cookie frais de session, en-têtes dangereux écartés", () => {
    const replay = buildReplayRequest(captured, { cookies: { luat: "frais", datadome: "dd1" } });
    expect(replay.url).toBe(captured.url);
    expect(replay.headers["User-Agent"]).toBe("UA-chrome");
    expect(replay.headers["Accept"]).toBe("application/json");
    expect(replay.headers["Cookie"]).toBe("luat=frais; datadome=dd1");
    expect(replay.headers).not.toHaveProperty("Content-Length");
    expect(replay.headers).not.toHaveProperty("Host");
  });

  it("surcharge URL/corps pour l'envoi", () => {
    const post: CapturedRequest = { ...captured, method: "POST", postData: '{"message":"salut"}' };
    const replay = buildReplayRequest(post, { cookies: { luat: "x" } }, { url: "https://www.leboncoin.fr/messaging/c/9/messages", body: '{"message":"réponse"}' });
    expect(replay.method).toBe("POST");
    expect(replay.url).toContain("/c/9/messages");
    expect(replay.body).toBe('{"message":"réponse"}');
  });
});
