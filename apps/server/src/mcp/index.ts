import { createInterface } from "node:readline";
import { loadConfig } from "../config.js";
import { Db, dbFile } from "../db.js";
import { createRepos } from "../repos.js";

/**
 * MCP local (phase 12) — serveur stdio JSON-RPC minimal, zéro dépendance.
 * Outils READ-ONLY sur la base locale. Lancement : `npm run mcp`.
 */

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const db = Db.open(dbFile(loadConfig().DATA_DIR));
const repos = createRepos(db);

const tools: ToolDef[] = [
  {
    name: "search_listings",
    description: "Recherche les annonces en base locale (résultats déjà scrapés). Filtres : query, priceMin/priceMax (euros), ownerType, category, limit.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        priceMin: { type: "number" },
        priceMax: { type: "number" },
        ownerType: { type: "string", enum: ["private", "pro"] },
        category: { type: "string" },
        limit: { type: "number", default: 20 },
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
    description: "Détail complet d'une annonce : prix, historique de prix, vendeur, attributs.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async (a) => {
      const id = String(a.id ?? "");
      const listing = repos.listings.byId(id);
      if (!listing) return { error: `annonce ${id} introuvable` };
      return { listing, priceHistory: repos.listings.priceHistory(id) };
    },
  },
  {
    name: "compare_listings",
    description: "Compare 2 à 4 annonces côte à côte (prix, ville, vendeur, pertinence, bonne affaire).",
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
    handler: async (a) => {
      const ids = Array.isArray(a.ids) ? a.ids.map(String).slice(0, 4) : [];
      return ids.map((id) => repos.listings.byId(id) ?? { id, error: "introuvable" });
    },
  },
  {
    name: "list_watchlists",
    description: "Liste les veilles actives avec leur cadence et leur dernier run.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => repos.watches.list(),
  },
  {
    name: "list_new_listings",
    description: "Annonces les plus récemment découvertes (par date de premier vu).",
    inputSchema: { type: "object", properties: { limit: { type: "number", default: 10 } } },
    handler: async (a) => {
      const { items } = repos.listings.search({
        limit: typeof a.limit === "number" ? Math.min(50, Math.max(1, a.limit)) : 10,
        offset: 0,
      });
      return items.map(summarize);
    },
  },
  {
    name: "list_conversations",
    description: "Conversations de la messagerie (locale, synchronisées).",
    inputSchema: { type: "object", properties: {} },
    handler: async () => repos.conversations.list(),
  },
  {
    name: "system_status",
    description: "État de la console : compteurs, veilles, automation, kill switch.",
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

function summarize(l: { id: string; title: string; priceCents?: number; category?: string; location?: { city?: string }; owner?: { type?: string }; score: number; url: string }) {
  return {
    id: l.id,
    title: l.title,
    priceEur: l.priceCents !== undefined ? l.priceCents / 100 : null,
    category: l.category ?? null,
    city: l.location?.city ?? null,
    ownerType: l.owner?.type ?? null,
    score: Math.round(l.score * 100) / 100,
    url: l.url,
  };
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
  if (req.method === undefined) return; // réponse d'un client — ignorée

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
        send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `méthode inconnue : ${req.method}` } });
      }
  }
});

rl.on("close", () => {
  db.raw.close();
  process.exit(0);
});
