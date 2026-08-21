import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Signature des webhooks HTTP génériques.
 * En-têtes : X-LBS-Event, X-LBS-Delivery, X-LBS-Timestamp, X-LBS-Signature.
 * Canonical = `${deliveryId}.${timestamp}.${event}.${body}`
 * Signature = `v1=` + HMAC_SHA256_HEX(secret, canonical)
 */
export function signDelivery(
  secret: string,
  event: string,
  deliveryId: string,
  timestamp: number,
  body: string
): string {
  const canonical = `${deliveryId}.${timestamp}.${event}.${body}`;
  return `v1=${createHmac("sha256", secret).update(canonical).digest("hex")}`;
}

export function deliveryHeaders(
  secret: string,
  event: string,
  body: string
): Record<string, string> {
  const deliveryId = randomUUID();
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    "Content-Type": "application/json",
    "X-LBS-Event": event,
    "X-LBS-Delivery": deliveryId,
    "X-LBS-Timestamp": String(timestamp),
    "X-LBS-Signature": signDelivery(secret, event, deliveryId, timestamp, body),
  };
}

export function verifyDelivery(
  secret: string,
  event: string,
  deliveryId: string,
  timestamp: number,
  body: string,
  signature: string
): boolean {
  const expected = signDelivery(secret, event, deliveryId, timestamp, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
