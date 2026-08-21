import { loadConfig } from "./config.js";
import { Db, dbFile } from "./db.js";
import { createVault } from "./security/vault.js";
import { createRepos } from "./repos.js";
import { Bus } from "./bus.js";
import { FixtureEngine } from "./adapters/leboncoin/engine.js";
import { LiveEngine } from "./adapters/leboncoin/live.js";
import { MessagingAdapter } from "./adapters/leboncoin/messaging.js";
import { CaptureSession } from "./adapters/chrome/capture.js";
import { parseProxy, type ProxyConfig } from "./domain/proxy.js";
import { startScheduler } from "./jobs/scheduler.js";
import { startOutbox } from "./jobs/outbox.js";
import { runRetention } from "./jobs/retention.js";
import { AutoResponder } from "./jobs/auto-responder.js";
import { buildServer } from "./server.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = Db.open(dbFile(cfg.DATA_DIR));
  db.migrate();
  const vault = await createVault(cfg.DATA_DIR);
  const repos = createRepos(db, (cipher) => vault.decrypt(cipher));
  const bus = new Bus(repos.events);
  logger.info({ vault: vault.kind, mode: cfg.LBC_MODE }, "démarrage console");

  const decryptSecret = async (name: string): Promise<string | null> => {
    const cipher = repos.secrets.get(name);
    try {
      return cipher ? await vault.decrypt(cipher) : null;
    } catch {
      return null;
    }
  };

  const storedProxy = async (): Promise<ProxyConfig | null> => {
    const raw = (await decryptSecret("proxy")) ?? (cfg.LBC_PROXY || null);
    if (!raw) return null;
    try {
      return parseProxy(raw);
    } catch {
      logger.warn("proxy stocké invalide — requêtes en direct");
      return null;
    }
  };

  /**
   * Politique de routage : chaque flux (search / messaging) passe par le proxy
   * ou en direct, au choix de l'opérateur. Défaut : tout en direct ; classique
   * voulu : search=proxy (volume), messaging=direct (IP résidentielle du compte).
   */
  const getProxyFor = async (kind: "search" | "messaging"): Promise<ProxyConfig | null> => {
    let policy = "direct";
    try {
      const raw = repos.settings.get("routing");
      policy = raw ? (JSON.parse(raw) as { search?: string; messaging?: string })[kind] ?? "direct" : "direct";
    } catch { /* politique illisible → direct */ }
    if (policy !== "proxy") return null;
    return storedProxy();
  };

  const getSessionProfile = async (): Promise<{ userAgent: string; cookies: Record<string, string>; authHeader?: string } | null> => {
    const raw = await decryptSecret("lbc_session");
    if (!raw) return null;
    try {
      const bundle = JSON.parse(raw) as { userAgent: string; cookies: Record<string, string>; authHeader?: string };
      return { userAgent: bundle.userAgent, cookies: bundle.cookies, authHeader: bundle.authHeader };
    } catch {
      return null;
    }
  };

  // Rafraîchissement du bearer : luat vit dans le localStorage du profil —
  // on ouvre le profil, le SPA renouvelle en silence, on relit.
  let refreshing = false;
  const refreshBearer = async (): Promise<boolean> => {
    if (refreshing) return false;
    refreshing = true;
    try {
      const { refreshSession } = await import("./adapters/chrome/token-refresh.js");
      const out = await refreshSession({ vault, repos, bus, dataDir: cfg.DATA_DIR, livePage: capture.running ? capture.livePage() : null });
      return out.refreshed;
    } catch {
      return false;
    } finally {
      refreshing = false;
    }
  };

  const engine =
    cfg.LBC_MODE === "live"
      ? new LiveEngine({
          repos,
          bus,
          getProxy: () => getProxyFor("search"),
          // repli DataDome : proxy stocké hors politique de routage
          getBackupProxy: () => storedProxy(),
          getAnysolverKey: () => decryptSecret("anysolver_key"),
          getSessionProfile,
          // filtre sémantique llmFilter : config LLM du coffre si présente
          getLlm: async () => {
            const apiKey = await decryptSecret("llm_key");
            if (!apiKey || !cfg.LLM_BASE_URL) return null;
            return { baseUrl: cfg.LLM_BASE_URL, apiKey, model: cfg.LLM_MODEL };
          },
        })
      : new FixtureEngine(repos, bus);

  const messaging = new MessagingAdapter({
    repos,
    getSession: getSessionProfile,
    getProxy: () => getProxyFor("messaging"),
    refresh: refreshBearer,
  });
  const capture = new CaptureSession(repos, bus, cfg.DATA_DIR);

  // Au boot : si une session existe, garantir les contrats messagerie — les
  // endpoints vérifiés sont matérialisés en synthétique si aucune capture
  // réelle ne les couvre (connexion seule = messagerie opérationnelle).
  void (async () => {
    try {
      const profile = await getSessionProfile();
      const raw = await decryptSecret("lbc_session");
      if (!profile || !raw) return;
      const bundle = JSON.parse(raw) as { userId?: string | null; authHeader?: string };
      let userId = bundle.userId ?? null;
      if (!userId && bundle.authHeader?.startsWith("Bearer ")) {
        const payload = JSON.parse(Buffer.from(bundle.authHeader.split(".")[1]!, "base64url").toString("utf8")) as { sub?: string };
        const sub = payload.sub?.split(";");
        if (sub && sub.length >= 2) userId = sub[1] ?? null;
      }
      if (userId) {
        const { ensureSyntheticContracts } = await import("./adapters/leboncoin/messaging.js");
        ensureSyntheticContracts(repos, userId, profile.userAgent);
      }
    } catch { /* session absente : rien à garantir */ }
  })();

  // pipeline automatique de messagerie : sync + réponses LLM (automation OFF par défaut)
  const autoResponder = new AutoResponder({
    repos,
    messaging,
    getLlm: async () => {
      const apiKey = await decryptSecret("llm_key");
      if (!apiKey || !cfg.LLM_BASE_URL) return null;
      return { baseUrl: cfg.LLM_BASE_URL, apiKey, model: cfg.LLM_MODEL };
    },
    bus,
  });
  const runMessagingTick = async () => {
    if (cfg.LBC_MODE !== "live") return;
    const automation = repos.settings.get("automation_enabled") === "1";
    const out = await autoResponder.processAndReply(automation);
    if (out.error || out.replied > 0) {
      logger.info(
        { synced: out.synced, created: out.created, replied: out.replied, skipped: out.skipped.length, err: out.error },
        automation ? "tick messagerie (auto-réponses)" : "tick messagerie (sync seule)"
      );
    }
  };

  // Garde-fou d'expiration : toutes les 10 min, si le bearer expire dans
  // moins de 25 min, on le renouvelle avant que la messagerie ne casse.
  const tokenWatch = setInterval(() => {
    void (async () => {
      const raw = await decryptSecret("lbc_session");
      if (!raw) return;
      try {
        const bundle = JSON.parse(raw) as { expiresAt?: string | null };
        if (!bundle.expiresAt) return;
        const msLeft = Date.parse(bundle.expiresAt) - Date.now();
        if (msLeft > 0 && msLeft < 25 * 60_000) {
          logger.info({ msLeft }, "bearer bientôt expiré — rafraîchissement préventif");
          await refreshBearer();
        }
      } catch { /* bundle illisible */ }
    })();
  }, 10 * 60_000);

  const scheduler = startScheduler(cfg, repos, engine, bus, runMessagingTick);
  const outbox = startOutbox(repos, bus);
  const retentionTimer = setInterval(() => runRetention(db, cfg), 6 * 3600_000);

  const app = await buildServer({
    cfg, db, vault, engine, repos, bus, scheduler, outbox,
    system: { capture, messaging, getProxyFor, storedProxy, autoResponder },
  });
  await app.listen({ host: cfg.HOST, port: cfg.PORT });
  logger.info(`console prête sur http://${cfg.HOST}:${cfg.PORT}`);

  const shutdown = async () => {
    scheduler.stop();
    outbox.stop();
    clearInterval(retentionTimer);
    clearInterval(tokenWatch);
    await app.close();
    db.raw.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  logger.error({ err }, "échec au démarrage");
  process.exit(1);
});
