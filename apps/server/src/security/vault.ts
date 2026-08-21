import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Coffre de secrets. En production Windows : DPAPI CurrentUser via @primno/dpapi
 * (aucune clé dérivée nécessaire, lié au compte de l'opérateur).
 * En dev hors Windows : chiffrement AES local avec clé dans data/.vault-key —
 * explicitement marqué NON-PROD, uniquement pour faire tourner les tests.
 */
export interface SecretVault {
  readonly kind: "dpapi" | "dev";
  encrypt(plain: string): Promise<string>;
  decrypt(ciphertextB64: string): Promise<string>;
}

class DpapiVault implements SecretVault {
  readonly kind = "dpapi" as const;
  private dpapi: typeof import("@primno/dpapi").Dpapi | null = null;

  private async bindings() {
    if (!this.dpapi) {
      const mod = await import("@primno/dpapi");
      this.dpapi = mod.Dpapi;
    }
    return this.dpapi;
  }

  async encrypt(plain: string): Promise<string> {
    const dpapi = await this.bindings();
    const ct = dpapi.protectData(Buffer.from(plain, "utf8"), null, "CurrentUser");
    return Buffer.from(ct).toString("base64");
  }

  async decrypt(b64: string): Promise<string> {
    const dpapi = await this.bindings();
    const pt = dpapi.unprotectData(Buffer.from(b64, "base64"), null, "CurrentUser");
    return Buffer.from(pt).toString("utf8");
  }
}

class DevVault implements SecretVault {
  readonly kind = "dev" as const;
  constructor(private readonly keyPath: string) {}

  private async key(): Promise<Buffer> {
    const { readFile, writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    try {
      return Buffer.from(await readFile(this.keyPath));
    } catch {
      const k = randomBytes(32);
      await mkdir(dirname(this.keyPath), { recursive: true });
      await writeFile(this.keyPath, k);
      return k;
    }
  }

  async encrypt(plain: string): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", await this.key(), iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]).toString("base64");
  }

  async decrypt(b64: string): Promise<string> {
    const buf = Buffer.from(b64, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", await this.key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  }
}

export async function createVault(dataDir: string): Promise<SecretVault> {
  if (process.platform === "win32") {
    try {
      const v = new DpapiVault();
      const probe = await v.encrypt("probe");
      if ((await v.decrypt(probe)) === "probe") return v;
    } catch {
      // DPAPI indisponible (module natif absent) → repli dev explicite
    }
  }
  const { join } = await import("node:path");
  return new DevVault(join(dataDir, ".vault-key"));
}
