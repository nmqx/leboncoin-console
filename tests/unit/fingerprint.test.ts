import { describe, expect, it } from "vitest";
import {
  FINGERPRINT_POOL,
  FINGERPRINT_SLOT_MS,
  pickFingerprint,
} from "../../apps/server/src/adapters/leboncoin/fingerprint.js";

describe("rotation des empreintes TLS", () => {
  it("change de profil à chaque créneau de cinq minutes, même sans mémoire locale", () => {
    expect(pickFingerprint([], 0)).toEqual(FINGERPRINT_POOL[0]);
    expect(pickFingerprint([], FINGERPRINT_SLOT_MS)).toEqual(FINGERPRINT_POOL[1]);
    expect(pickFingerprint([], 2 * FINGERPRINT_SLOT_MS)).toEqual(FINGERPRINT_POOL[2]);
  });

  it("saute un profil explicitement exclu", () => {
    expect(pickFingerprint([FINGERPRINT_POOL[0]!], 0)).toEqual(FINGERPRINT_POOL[1]);
  });
});
