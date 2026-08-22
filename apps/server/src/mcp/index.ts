import { createInterface } from "node:readline";
import { loadConfig } from "../config.js";
import { Db, dbFile } from "../db.js";
import { createRepos } from "../repos.js";

/**
 * MCP local — serveur stdio JSON-RPC minimal, zero dependance.
 * Expose la console Leboncoin aux agents IA via Model Context Protocol.
 * Lancement : `npm run mcp` ou `npx tsx apps/server/src/mcp/index.ts`
 */

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const db = Db.open(dbFile(loadConfig().DATA_DIR));
const repos = createRepos(db);
db.migrate();

function summarize(l: { id: string; title: string; priceCents?: number; category?: string; location?: { city?: string }; owner?: { type?: string }; score: number; url: string; attributes?: Record<string, unknown> }) {
  return {
    id: l.id,
    title: l.title,
    priceEur: l.priceCents !== undefined ? l.priceCents / 100 : null,
    category: l.category ?? null,
    city: l.location?.city ?? null,
    ownerType: l.owner?.type ?? null,
    score: Math.round(l.score * 100) / 100,
    achatEnCours: (l.attributes as Record<string, unknown>)?._achatEnCours === true,
    url: l.url,
  };
}

const tools: ToolDef[] = [
  {
    name: "search_listings",
    description: "Recherche les annonces en base locale (deja scrapees). Filtres : query, priceMin/priceMax en euros, ownerType, category, limit. Tri par date de publication.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Texte de recherche, ex: iphone 13 pro" },
        priceMin: { type: "number", description: "Prix minimum en euros" },
        priceMax: { type: "number", description: "Prix maximum en euros" },
        ownerType: { type: "string", enum: ["private", "pro"] },
        category: { type: "string", description: "Categorie Leboncoin" },
        limit: { type: "number", default: 20, description: "Nombre max de resultats, 1 a 100" },
      },
    },
    handler: async (a) => {
      const { items, total } = repos.listings.search({
        query: typeof a.query === "string" && a.query ? a.query : undefined,
        priceMin: typeof a.priceMin === "number" ? Math.round(a.priceMin * 100) : undefined,
        priceMax: typeof a.priceMax === "number" ? Math.round(a.priceMax * 100) : undefined,
        ownerType: a.ownerType === "private" || a.ownerType === "pro" ? a.ownerType : undefined,
        category: typeof a.category === "string" ? a.category : undefined,
        limit: typeof a.limit === "number" ? Math.min(100, Math.max(1, a.limit)) : 20,
        offset: 0,
      });
      return { total, items: items.map(summarize) };
    },
  },
  {
    name: "get_listing",
    description: "Detail complet d une annonce : prix, historique de prix, vendeur, attributs, badge achat en cours.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "ID annonce" } }, required: ["id"] },
    handler: async (a) => {
      const id = String(a.id ?? "");
      const listing = repos.listings.byId(id);
      if (!listing) return { error: `annonce ${id} introuvable` };
      return { listing, priceHistory: repos.listings.priceHistory(id) };
    },
  },
  {
    name: "compare_listings",
    description: "Compare 2 a 4 annonces cote a cote.",
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
    handler: async (a) => {
      const ids = Array.isArray(a.ids) ? a.ids.map(String).slice(0, 4) : [];
      return ids.map((id) => repos.listings.byId(id) ?? { id, error: "introuvable" });
    },
  },
  {
    name: "list_watches",
    description: "Liste les veilles avec cadence, dernier run, statut et webhooks assignes.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => repos.watches.list().map((w) => ({ ...w, listingCount: repos.watches.listingCount(w.id), webhookIds: repos.webhooks.webhookIdsForWatch(w.id) })),
  },
  {
    name: "get_watch",
    description: "Detail d une veille par ID.",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
    handler: async (a) => {
      const w = repos.watches.byId(Number(a.id));
      if (!w) return { error: `veille ${a.id} introuvable` };
      return { ...w, listingCount: repos.watches.listingCount(w.id), webhookIds: repos.webhooks.webhookIdsForWatch(w.id) };
    },
  },
  {
    name: "create_watch",
    description: "Cree une veille : surveille une recherche et notifie via webhooks assignes.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nom de la veille" },
        query: { type: "string", description: "Requete texte" },
        priceMin: { type: "number" },
        priceMax: { type: "number" },
        cadenceMinutes: { type: "number", default: 10, description: "Cadence en minutes, 1 a 1440" },
        webhookIds: { type: "array", items: { type: "number" }, description: "IDs des webhooks a assigner, vide = global" },
      },
      required: ["name", "query"],
    },
    handler: async (a) => {
      const name = String(a.name ?? "Veille");
      const query = String(a.query ?? "");
      if (!query.trim()) throw new Error("query requise");
      const spec: Record<string, unknown> = { query: query.trim(), maxItems: 200, filterJunk: true, llmFilter: true };
      if (typeof a.priceMin === "number") (spec as Record<string, unknown>).priceCents = { ...(spec.priceCents as object ?? {}), min: Math.round(a.priceMin * 100) };
      if (typeof a.priceMax === "number") (spec as Record<string, unknown>).priceCents = { ...(spec.priceCents as object ?? {}), max: Math.round(a.priceMax * 100) };
      const cadence = typeof a.cadenceMinutes === "number" ? a.cadenceMinutes : 10;
      const watch = repos.watches.create(name, spec as never, cadence);
      if (Array.isArray(a.webhookIds) && a.webhookIds.length > 0) {
        repos.webhooks.setWatchWebhooks(watch.id, a.webhookIds.map(Number));
      }
      return watch;
    },
  },
  {
    name: "delete_watch",
    description: "Supprime une veille.",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
    handler: async (a) => {
      const ok = repos.watches.delete(Number(a.id));
      return { ok, id: a.id };
    },
  },
  {
    name: "list_watch_results",
    description: "Resultats d une veille : annonces liees a cette veille.",
    inputSchema: { type: "object", properties: { watchId: { type: "number" }, limit: { type: "number", default: 50 } }, required: ["watchId"] },
    handler: async (a) => {
      const wid = Number(a.watchId);
      const w = repos.watches.byId(wid);
      if (!w) return { error: `veille ${wid} introuvable` };
      const { items, total } = repos.listings.search({ watchId: wid, limit: typeof a.limit === "number" ? Math.min(200, Math.max(1, a.limit)) : 50, offset: 0 });
      return { watch: w, total, items: items.map(summarize) };
    },
  },
  {
    name: "list_new_listings",
    description: "Annonces les plus recemment decouvertes.",
    inputSchema: { type: "object", properties: { limit: { type: "number", default: 10 } } },
    handler: async (a) => {
      const { items } = repos.listings.search({ limit: typeof a.limit === "number" ? Math.min(50, Math.max(1, a.limit)) : 10, offset: 0 });
      return items.map(summarize);
    },
  },
  {
    name: "list_conversations",
    description: "Conversations messagerie locale.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => repos.conversations.list(),
  },
  {
    name: "get_conversation",
    description: "Detail d une conversation avec ses messages.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async (a) => {
      const c = repos.conversations.byId(String(a.id));
      if (!c) return { error: `conversation ${a.id} introuvable` };
      return { conversation: c, messages: repos.conversations.messages(String(a.id)) };
    },
  },
  {
    name: "list_webhooks",
    description: "Liste les webhooks configures.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => repos.webhooks.list().map((w) => ({ ...w, watchIds: repos.webhooks.watchIdsForWebhook(w.id) })),
  },
  {
    name: "set_watch_webhooks",
    description: "Assigne des webhooks a une veille (vide = global).",
    inputSchema: { type: "object", properties: { watchId: { type: "number" }, webhookIds: { type: "array", items: { type: "number" } } }, required: ["watchId", "webhookIds"] },
    handler: async (a) => {
      const wid = Number(a.watchId);
      const ids = Array.isArray(a.webhookIds) ? a.webhookIds.map(Number) : [];
      if (!repos.watches.byId(wid)) return { error: `veille ${wid} introuvable` };
      repos.webhooks.setWatchWebhooks(wid, ids);
      return { watchId: wid, webhookIds: repos.webhooks.webhookIdsForWatch(wid) };
    },
  },
  {
    name: "list_jobs",
    description: "Derniers jobs de recherche.",
    inputSchema: { type: "object", properties: { limit: { type: "number", default: 10 } } },
    handler: async (a) => repos.jobs.recent(typeof a.limit === "number" ? Math.min(50, Math.max(1, a.limit)) : 10),
  },
  {
    name: "system_status",
    description: "Etat console : compteurs, veilles, automation, kill switch.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({
      listings: repos.listings.count(),
      conversations: repos.conversations.count(),
      watches: repos.watches.list().length,
      pendingDeliveries: repos.webhooks.pendingCount(),
      automation: { enabled: repos.settings.get("automation_enabled") === "1", killSwitch: repos.settings.get("kill_switch") === "1" },
    }),
  },
];

function summarizeBrief(l: { id: string; title: string }) {
  return l.id;
}

// ---------------------------------------------------------------------------
// Boucle JSON-RPC stdio
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin });

const send = (msg: unknown) => {
  process.stdout.write(JSON.stringify(msg) + "\n");
};

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req: { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown>; result?: unknown };
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (req.method === undefined) return;

  switch (req.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "lbc-console", version: "0.1.0" },
        },
      });
      break;
    case "notifications/initialized":
      break;
    case "tools/list":
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
      });
      break;
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: `outil inconnu : ${name}` }], isError: true } });
        break;
      }
      void tool
        .handler((req.params?.arguments as Record<string, unknown>) ?? {})
        .then((data) =>
          send({
            jsonrpc: "2.0",
            id: req.id,
            result: { content: [{ type: "text", text: JSON.stringify(data, null, 1) }] },
          })
        )
        .catch((err: Error) =>
          send({
            jsonrpc: "2.0",
            id: req.id,
            result: { content: [{ type: "text", text: err.message }], isError: true },
          })
        );
      break;
    }
    case "ping":
      send({ jsonrpc: "2.0", id: req.id, result: {} });
      break;
    default:
      if (req.id !== undefined && req.id !== null) {
        send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `methode inconnue : ${req.method}` } });
      }
  }
});

rl.on("close", () => {
  db.raw.close();
  process.exit(0);
});
