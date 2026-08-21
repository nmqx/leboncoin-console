import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { config as loadDotenv } from "dotenv";

// Racine du repo, résolue depuis CE fichier — indépendante du cwd de lancement
// (piège réel : `npm -w apps/server` lance avec cwd=apps/server, un DATA_DIR
// relatif créait alors une seconde base vierge → déauth + données perdues).
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const CONFIG_JSON_PATH = path.join(REPO_ROOT, "console.config.json");
const DEFAULT_DATA_DIR = path.join(REPO_ROOT, "data");

loadDotenv(); // cwd (apps/server en dev)…
loadDotenv({ path: path.join(REPO_ROOT, ".env") }); // …et racine du repo

const EnvSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().default(8787),
  LBC_MODE: z.enum(["fixtures", "live"]).default("fixtures"),
  DATA_DIR: z.string().default(""),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  LLM_BASE_URL: z.string().default(""),
  LLM_MODEL: z.string().default("gemini-3.7-flash-high"),
  // Proxy optionnel au démarrage ; sinon stocké dans le coffre DPAPI via l'UI.
  LBC_PROXY: z.string().default(""),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  retentionDays: { listings: number; messages: number; logs: number };
  scheduler: { cadenceMinutes: number; jitterMaxSeconds: number };
  replyLimits: { perHourPerConversation: number; perDay: number; debounceSeconds: number };
  anysolver: { dailyChallengeBudget: number; maxAttemptsPerJob: number };
};

/**
 * Configuration persistée (console.config.json à la racine du repo) : ce qui a
 * été choisi à une session reste la valeur par défaut de la suivante — mode
 * live, emplacement de la base, gateway LLM. Aucun secret ici (coffre DPAPI).
 */
export interface PersistedConfig {
  mode: "fixtures" | "live";
  dataDir: string;
  llmBaseUrl: string;
  llmModel: string;
  host: string;
  port: number;
}

function readPersisted(): Partial<PersistedConfig> {
  try {
    return JSON.parse(readFileSync(CONFIG_JSON_PATH, "utf8")) as Partial<PersistedConfig>;
  } catch {
    return {};
  }
}

function writePersisted(cfg: PersistedConfig): void {
  writeFileSync(CONFIG_JSON_PATH, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const disk = readPersisted();
  const parsed = EnvSchema.parse(env);

  // Priorité : env explicite de CE lancement > config persistée > défaut.
  const mode = (env.LBC_MODE as PersistedConfig["mode"] | undefined) ?? disk.mode ?? "fixtures";
  const dataDir = env.DATA_DIR && env.DATA_DIR !== "" ? env.DATA_DIR : (disk.dataDir ?? DEFAULT_DATA_DIR);
  const llmBaseUrl = parsed.LLM_BASE_URL !== "" ? parsed.LLM_BASE_URL : (disk.llmBaseUrl ?? "");
  const llmModel = parsed.LLM_MODEL !== "gemini-3.7-flash-high" ? parsed.LLM_MODEL : (disk.llmModel ?? parsed.LLM_MODEL);
  const host = parsed.HOST !== "127.0.0.1" ? parsed.HOST : (disk.host ?? parsed.HOST);
  const port = parsed.PORT !== 8787 ? parsed.PORT : (disk.port ?? parsed.PORT);

  // Persister la configuration effective (uniquement au vrai démarrage, pas
  // dans les tests qui injectent des env factices).
  if (env === process.env) {
    const effective: PersistedConfig = { mode, dataDir, llmBaseUrl, llmModel, host, port };
    const current = JSON.stringify(readPersisted());
    if (current !== JSON.stringify(effective)) writePersisted(effective);
  }

  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  return {
    HOST: host,
    PORT: port,
    LBC_MODE: mode,
    DATA_DIR: dataDir,
    WEB_ORIGIN: parsed.WEB_ORIGIN,
    LLM_BASE_URL: llmBaseUrl,
    LLM_MODEL: llmModel,
    LBC_PROXY: parsed.LBC_PROXY,
    retentionDays: { listings: 180, messages: 90, logs: 30 },
    scheduler: { cadenceMinutes: 10, jitterMaxSeconds: 90 },
    replyLimits: { perHourPerConversation: 10, perDay: 100, debounceSeconds: 20 },
    anysolver: { dailyChallengeBudget: 100, maxAttemptsPerJob: 2 },
  };
}
