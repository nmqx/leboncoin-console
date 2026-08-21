import { join } from "node:path";
import type { Bus } from "../../bus.js";
import type { Repos } from "../../repos.js";
import { CdpClient, launchChromeDebug, pickLbcTarget } from "./cdp.js";
import type { SecretVault } from "../../security/vault.js";
import { logger } from "../../logger.js";

/**
 * Rafraîchissement du bearer : le jeton `luat` vit dans le localStorage du
 * profil Chrome connecté (pas de cookie, pas d'endpoint direct). Au
 * chargement du site, le SPA lit luat — expiré, il le renouvelle en silence
 * via les cookies de session d'auth.leboncoin.fr. Le rafraîchisseur ouvre
 * donc le profil, laisse le SPA faire, et relit luat + cookies.
 */
export interface RefreshOutcome {
  refreshed: boolean;
  reason?: string;
  expiresAt: string | null;
  userId: string | null;
}

interface SessionBundle {
  format: string;
  cookies: Record<string, string>;
  authHeader: string;
  userId: string | null;
  userAgent: string;
  expiresAt: string | null;
  importedAt: string;
}

export function decodeLuat(luat: string): { userId: string | null; expiresAt: string | null } {
  try {
    const payload = JSON.parse(Buffer.from(luat.split(".")[1]!, "base64url").toString("utf8")) as {
      sub?: string; exp?: number;
    };
    const subParts = payload.sub?.split(";");
    return {
      userId: subParts && subParts.length >= 2 ? (subParts[1] ?? null) : null,
      expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
    };
  } catch {
    return { userId: null, expiresAt: null };
  }
}

/** Lit luat + cookies depuis un onglet Leboncoin déjà ouvert (capture vivante). */
export async function readTokenFromPage(
  page: CdpClient
): Promise<{ luat: string | null; cookies: Array<{ name: string; value: string }> }> {
  const res = (await page.send("Runtime.evaluate", {
    expression: "localStorage.getItem('luat') || ''",
    returnByValue: true,
  })) as { result?: { value?: string } };
  const luat = res.result?.value && res.result.value.length > 50 ? res.result.value : null;
  const cookiesRes = (await page.send("Network.getCookies", {
    urls: ["https://www.leboncoin.fr", "https://api.leboncoin.fr", "https://auth.leboncoin.fr"],
  })) as { cookies?: Array<{ name: string; value: string }> };
  return { luat, cookies: cookiesRes.cookies ?? [] };
}

export async function persistBundle(
  vault: SecretVault,
  repos: Repos,
  bus: Bus,
  current: SessionBundle,
  luat: string,
  cookies: Array<{ name: string; value: string }>
): Promise<RefreshOutcome> {
  const lbc: Record<string, string> = { ...current.cookies };
  for (const c of cookies) lbc[c.name] = c.value;
  const { userId, expiresAt } = decodeLuat(luat);
  const bundle: SessionBundle = {
    ...current,
    cookies: lbc,
    authHeader: `Bearer ${luat}`,
    userId: userId ?? current.userId,
    expiresAt,
    importedAt: new Date().toISOString(),
  };
  repos.secrets.set("lbc_session", await vault.encrypt(JSON.stringify(bundle)));
  // Contrats messagerie synthétiques si absents — le refresh suffit à rendre
  // la messagerie opérationnelle sans nouvelle capture.
  if (bundle.userId) {
    try {
      const { ensureSyntheticContracts } = await import("../leboncoin/messaging.js");
      ensureSyntheticContracts(repos, bundle.userId, bundle.userAgent);
    } catch { /* non bloquant */ }
  }
  repos.audit.insert("session.refresh", { userId: bundle.userId, expiresAt });
  bus.publish("session.refreshed", { userId: bundle.userId, expiresAt });
  logger.info({ expiresAt }, "bearer rafraîchi");
  return { refreshed: true, expiresAt, userId: bundle.userId };
}

/**
 * Rafraîchissement complet : ouvre le profil stable (fenêtre discrète hors
 * champ), charge le site, relit luat + cookies, referme proprement.
 * Si `livePage` est fourni (capture en cours), lit directement dedans —
 * aucun second Chrome lancé.
 */
export async function refreshSession(opts: {
  vault: SecretVault;
  repos: Repos;
  bus: Bus;
  dataDir: string;
  livePage?: CdpClient | null;
}): Promise<RefreshOutcome> {
  const cipher = opts.repos.secrets.get("lbc_session");
  if (!cipher) return { refreshed: false, reason: "aucune session en coffre", expiresAt: null, userId: null };
  let current: SessionBundle;
  try {
    current = JSON.parse(await opts.vault.decrypt(cipher)) as SessionBundle;
  } catch {
    return { refreshed: false, reason: "session en coffre illisible", expiresAt: null, userId: null };
  }

  // 1. capture vivante → lecture directe
  if (opts.livePage) {
    try {
      const { luat, cookies } = await readTokenFromPage(opts.livePage);
      if (luat) return persistBundle(opts.vault, opts.repos, opts.bus, current, luat, cookies);
    } catch { /* on retente avec un chrome dédié */ }
  }

  // 2. chrome dédié sur le profil stable
  const handle = await launchChromeDebug({
    profileDir: join(opts.dataDir, "chrome-profile"),
    startUrl: "https://www.leboncoin.fr/",
    extraArgs: ["--window-size=900,700", "--window-position=-2400,-2400"],
  });
  try {
    // laisse le SPA charger et (si expiré) renouveler luat en silence
    let luat: string | null = null;
    let cookies: Array<{ name: string; value: string }> = [];
    for (let i = 0; i < 15 && !luat; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const target = await pickLbcTarget(handle.port).catch(() => null);
      if (!target?.webSocketDebuggerUrl) continue;
      const page = await CdpClient.connect(target.webSocketDebuggerUrl).catch(() => null);
      if (!page) continue;
      try {
        const read = await readTokenFromPage(page);
        luat = read.luat;
        cookies = read.cookies;
      } finally {
        page.close();
      }
    }
    if (!luat) {
      return { refreshed: false, reason: "luat absent du localStorage — reconnexion requise (Système → Chrome)", expiresAt: null, userId: null };
    }
    return await persistBundle(opts.vault, opts.repos, opts.bus, current, luat, cookies);
  } finally {
    try { await (await CdpClient.connect(handle.browserWsUrl)).send("Browser.close"); } catch { /* déjà fermé */ }
    await new Promise((r) => setTimeout(r, 1200));
    try { handle.process.kill(); } catch { /* déjà parti */ }
  }
}
