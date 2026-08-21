import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { signDelivery, deliveryHeaders, verifyDelivery } from "../../apps/server/src/security/hmac.js";

describe("signature HMAC webhooks", () => {
  const secret = "s3cr3t-de-test";
  const canonical = (deliveryId: string, ts: number, event: string, body: string) =>
    `${deliveryId}.${ts}.${event}.${body}`;

  it("vecteur déterministe v1=HMAC_SHA256_HEX", () => {
    const sig = signDelivery(secret, "listing.created", "d-123", 1_700_000_000, '{"a":1}');
    const expected = `v1=${createHmac("sha256", secret).update(canonical("d-123", 1_700_000_000, "listing.created", '{"a":1}')).digest("hex")}`;
    expect(sig).toBe(expected);
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
  });

  it("deliveryHeaders expose les quatre en-têtes X-LBS-*", () => {
    const h = deliveryHeaders(secret, "reply.sent", "{}");
    expect(h["X-LBS-Event"]).toBe("reply.sent");
    expect(h["X-LBS-Delivery"]).toBeDefined();
    expect(h["X-LBS-Timestamp"]).toMatch(/^\d+$/);
    expect(h["X-LBS-Signature"]).toMatch(/^v1=/);
  });

  it("verifyDelivery accepte le bon et rejette l'altéré", () => {
    const deliveryId = "d-1";
    const ts = 1_700_000_000;
    const event = "listing.price_changed";
    const body = '{"price":10}';
    const sig = signDelivery(secret, event, deliveryId, ts, body);
    expect(verifyDelivery(secret, event, deliveryId, ts, body, sig)).toBe(true);
    expect(verifyDelivery(secret, event, deliveryId, ts, '{"price":11}', sig)).toBe(false);
    expect(verifyDelivery("autre-clef", event, deliveryId, ts, body, sig)).toBe(false);
  });
});
