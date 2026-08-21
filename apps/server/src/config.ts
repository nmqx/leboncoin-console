import { z } from "zod";
import { config as loadDotenv } from "dotenv";

loadDotenv();

const EnvSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().default(8787),
  LBC_MODE: z.enum(["fixtures", "live"]).default("fixtures"),
  DATA_DIR: z.string().default("./data"),
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  return {
    ...parsed,
    retentionDays: { listings: 180, messages: 90, logs: 30 },
    scheduler: { cadenceMinutes: 10, jitterMaxSeconds: 90 },
    replyLimits: { perHourPerConversation: 10, perDay: 100, debounceSeconds: 20 },
    anysolver: { dailyChallengeBudget: 100, maxAttemptsPerJob: 2 },
  };
}
