import { join } from "node:path";
import type { Bus } from "../../bus.js";
import type { Repos } from "../../repos.js";
import {
  CdpClient, launchChromeDebug, pickLbcTarget, getAllCookies,
  type ChromeHandle,
} from "./cdp.js";
import { logger } from "../../logger.js";

/**
 * Session de capture : Chrome réel lancé avec DevTools, l'opérateur se connecte
 * à la main, on écoute le réseau (CDP Network.*) et on persiste les requêtes
 * Leboncoin intéressantes. Zéro pilotage de page : l'opérateur navigue, on écoute.
 */
export interface CaptureState {
  startedAt: string;
  port: number;
  chromePath: string;
  capturedCount: number;
}

export class CaptureSession {
  private chrome: ChromeHandle | null = null;
  private browserWs: CdpClient | null = null;
  private pageWs: CdpClient | null = null;
  private pageAttach: Promise<void> | null = null;
  private state: CaptureState | null = null;
  private capturedCount = 0;

  constructor(
    private readonly repos: Repos,
    private readonly bus: Bus,
    private readonly dataDir: string
  ) {}

  get running(): boolean {
    return this.state !== null;
  }

  status(): CaptureState | null {
    return this.state ? { ...this.state, capturedCount: this.capturedCount } : null;
  }

  /** Page CDP vivante (pour lecture de token pendant une capture). */
  livePage(): CdpClient | null {
    return this.pageWs;
  }

  /**
   * Import automatique : le modèle de session actuel de Leboncoin est un
   * bearer JWT dans l'en-tête Authorization (API v3) + cookies (endpoints
   * HAL) — pas de cookie luat. Dès qu'une requête capturée porte
   * l'autorisation et que les cookies sont là, la session est sécurisée.
   */
  private sessionSecured = false;
  private autoImportInfo: { userId: string | null; expiresAt: string | null } | null = null;

  private async tryAutoImport(): Promise<void> {
    if (this.sessionSecured || !this.browserWs || !this.pageWs || !this.vault) return;
    try {
      const withAuth = this.repos.captured
        .list(30, "inbox")
        .find((c) => (c.requestHeaders["authorization"] ?? c.requestHeaders["Authorization"] ?? "").length > 20);
      if (!withAuth) return;

      const res = (await this.pageWs.send("Network.getCookies", {
        urls: ["https://www.leboncoin.fr", "https://api.leboncoin.fr", "https://auth.leboncoin.fr"],
      })) as { cookies?: Array<{ name: string; value: string }> };
      const cookies = res.cookies ?? [];
      if (!cookies.some((c) => c.name === "lbc_user_id" || c.name === "datadome")) return;

      const authHeader = withAuth.requestHeaders["authorization"] ?? withAuth.requestHeaders["Authorization"]!;
      let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
      try {
        const v = (await this.browserWs.send("Browser.getVersion")) as { userAgent?: string };
        if (v.userAgent) ua = v.userAgent;
      } catch { /* UA par défaut */ }

      // décodage du JWT : sub = lbc;<userId>;<storeId>, exp = expiration
      let userId: string | null = null;
      let expiresAt: string | null = null;
      try {
        const payload = JSON.parse(
          Buffer.from(authHeader.replace(/^Bearer /, "").split(".")[1]!, "base64url").toString("utf8")
        ) as { sub?: string; exp?: number };
        const subParts = payload.sub?.split(";");
        if (subParts && subParts.length >= 2) userId = subParts[1] ?? null;
        if (payload.exp) expiresAt = new Date(payload.exp * 1000).toISOString();
      } catch { /* JWT illisible */ }

      const lbc: Record<string, string> = {};
      for (const c of cookies) lbc[c.name] = c.value;
      if (!userId && lbc["lbc_user_id"]) userId = lbc["lbc_user_id"];

      const cipher = await this.vault.encrypt(
        JSON.stringify({
          format: "chrome-devtools",
          cookies: lbc,
          authHeader,
          userId,
          userAgent: ua,
          expiresAt,
          importedAt: new Date().toISOString(),
        })
      );
      this.repos.secrets.set("lbc_session", cipher);
      this.sessionSecured = true;
      this.autoImportInfo = { userId, expiresAt };
      this.repos.audit.insert("session.chrome_auto_import", { cookies: Object.keys(lbc).length, userId });
      this.bus.publish("session.imported", { auto: true, userId, expiresAt });
      logger.info({ userId }, "session sécurisée automatiquement (bearer + cookies)");
    } catch { /* pas encore */ }
  }

  private vault: { encrypt(s: string): Promise<string> } | null = null;

  async start(vault: { encrypt(s: string): Promise<string> }): Promise<CaptureState> {
    if (this.running) return this.status()!;
    this.vault = vault;
    this.sessionSecured = false;
    // profil STABLE : le login survit à la fermeture de la fenêtre — rouvrir
    // ne demande jamais de se reconnecter. Chemin résolu en absolu côté CDP.
    const handle = await launchChromeDebug({
      profileDir: join(this.dataDir, "chrome-profile"),
      startUrl: "https://www.leboncoin.fr/",
    });
    this.chrome = handle;
    this.state = {
      startedAt: new Date().toISOString(),
      port: handle.port,
      chromePath: "chrome",
      capturedCount: 0,
    };

    this.browserWs = await CdpClient.connect(handle.browserWsUrl);

    // écoute réseau sur l'onglet Leboncoin — la promesse d'attachement est
    // conservée : finish() l'attend avant de collecter les cookies
    this.pageAttach = this.attachPage();
    this.repos.audit.insert("chrome.capture_start", { port: handle.port });
    this.bus.publish("chrome.capture_started", { port: handle.port });
    return this.status()!;
  }

  private async attachPage(retries = 20): Promise<void> {
    for (let i = 0; i < retries; i++) {
      if (!this.running) return;
      const target = await pickLbcTarget(this.chrome!.port).catch(() => null);
      if (target?.webSocketDebuggerUrl) {
        const page = await CdpClient.connect(target.webSocketDebuggerUrl).catch(() => null);
        if (page) {
          this.pageWs = page;
          await page.send("Network.enable");
          this.wireNetwork(page);
          // poll d'import automatique tant que la capture vit
          const timer = setInterval(() => {
            if (!this.running) {
              clearInterval(timer);
              return;
            }
            void this.tryAutoImport();
          }, 4000);
          logger.info("capture réseau attachée à l'onglet Leboncoin");
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  private wireNetwork(page: CdpClient): void {
    const requests = new Map<string, { method: string; url: string; headers: Record<string, string>; postData?: string }>();

    page.on("Network.requestWillBeSent", (p) => {
      const r = p.request as { method: string; url: string; headers: Record<string, string>; postData?: string };
      if (!/leboncoin\.fr|lbc\.app/i.test(r.url)) return;
      // messagerie + API + tout ce qui touche l'auth : la requête qui émet le
      // bearer est ailleurs dans le site (auth.leboncoin.fr, /oauth, /token)
      if (!/messaging|conversation|hal\/|api\/|oauth|token|auth|session|account/i.test(r.url)) return;
      if (/\.(js|css|png|jpe?g|svg|woff2?|gif|ico)(\?|$)/i.test(r.url)) return;
      requests.set(p.requestId as string, { method: r.method, url: r.url, headers: r.headers, postData: r.postData });
    });

    page.on("Network.responseReceived", (p) => {
      const req = requests.get(p.requestId as string);
      if (!req) return;
      requests.delete(p.requestId as string);
      const cookieHeader = req.headers["Cookie"] ?? req.headers["cookie"] ?? "";
      const cookieNames = cookieHeader
        .split(";")
        .map((c) => c.split("=")[0]?.trim())
        .filter((n): n is string => !!n);
      const safeHeaders: Record<string, string> = { ...req.headers };
      delete safeHeaders["Cookie"];
      delete safeHeaders["cookie"];
      try {
        this.repos.captured.insert({
          method: req.method,
          url: req.url,
          status: (p.response as { status?: number }).status ?? null,
          requestHeaders: safeHeaders,
          cookieNames,
          postData: req.postData ?? null,
        });
        this.capturedCount++;
        this.bus.publish("chrome.request_captured", {
          method: req.method,
          url: req.url,
          status: (p.response as { status?: number }).status ?? null,
        });
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "insertion capture échouée");
      }
    });
  }

  /**
   * Clôture : cookies complet → session Leboncoin chiffrée DPAPI, UA réel,
   * puis arrêt propre de Chrome. Retourne ce qui a été capturé.
   */
  async finish(vault?: { encrypt(s: string): Promise<string> }): Promise<{
    imported: boolean;
    userId: string | null;
    expiresAt: string | null;
    capturedCount: number;
  }> {
    if (vault) this.vault = vault;
    let imported = this.sessionSecured;
    let userId: string | null = null;
    let expiresAt: string | null = null;

    try {
      if (this.browserWs) {
        // laisse l'attachement de page aboutir (jusqu'à 20 s) avant collecte
        if (this.pageAttach) await Promise.race([this.pageAttach, new Promise((r) => setTimeout(r, 20_000))]);
        const cookies = await getAllCookies(this.browserWs, this.pageWs);
        logger.info(
          { domains: [...new Set(cookies.map((c) => c.domain))], count: cookies.length },
          "cookies collectés (noms de domaines seulement)"
        );
        const lbc: Record<string, string> = {};
        let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
        for (const c of cookies) {
          if (/leboncoin\.fr$/i.test(c.domain.replace(/^\./, "")) || c.domain.includes("leboncoin.fr")) {
            lbc[c.name] = c.value;
          }
        }
        // UA réel depuis la version du navigateur DevTools
        try {
          const v = (await this.browserWs.send("Browser.getVersion")) as { userAgent?: string };
          if (v.userAgent) ua = v.userAgent;
        } catch { /* UA par défaut */ }
        if (lbc["luat"]) {
          const bundle = {
            format: "chrome-devtools",
            cookies: lbc,
            localStorage: {},
            userId: lbc["lbc_user_id"] ?? null,
            userAgent: ua,
            importedAt: new Date().toISOString(),
          };
          const cipher = await (vault ?? this.vault)!.encrypt(JSON.stringify(bundle));
          this.repos.secrets.set("lbc_session", cipher);
          imported = true;
          userId = bundle.userId;
          // expiration du JWT luat
          try {
            const payload = JSON.parse(Buffer.from(lbc["luat"].split(".")[1]!, "base64url").toString("utf8")) as { exp?: number; sub?: string };
            if (payload.exp) expiresAt = new Date(payload.exp * 1000).toISOString();
            if (!userId && payload.sub) userId = payload.sub;
          } catch { /* JWT illisible : pas d'expiration connue */ }
          this.sessionSecured = true;
          this.repos.audit.insert("session.chrome_import", { cookies: Object.keys(lbc).length, userId });
          this.bus.publish("session.imported", { userId, expiresAt });
        }
      }
      // import automatique déjà fait pendant la session → infos mémorisées
      if (!imported && this.sessionSecured && this.autoImportInfo) {
        imported = true;
        userId = this.autoImportInfo.userId;
        expiresAt = this.autoImportInfo.expiresAt;
      }
    } finally {
      this.pageWs?.close();
      // Fermeture GRÂCEUSE d'abord : Browser.close laisse Chrome écrire ses
      // cookies sur disque — un kill brutal efface les cookies de session
      // (luat est en mémoire jusqu'à la fermeture propre). Kill en dernier
      // recours seulement.
      try {
        if (this.browserWs) await this.browserWs.send("Browser.close");
      } catch { /* déjà fermé */ }
      await new Promise((r) => setTimeout(r, 1500));
      try { this.chrome?.process.kill(); } catch { /* déjà parti */ }
      this.browserWs?.close();
      this.pageWs = null;
      this.browserWs = null;
      this.chrome = null;
      const st = this.state;
      this.state = null;
      this.repos.audit.insert("chrome.capture_finish", { captured: this.capturedCount, imported });
      this.bus.publish("chrome.capture_finished", { captured: this.capturedCount, imported });
      void st;
    }
    return { imported, userId, expiresAt, capturedCount: this.capturedCount };
  }
}
