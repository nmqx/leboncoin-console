import type { ProxyConfig } from "../../domain/proxy.js";
import { toAnySolverProxy } from "../../domain/proxy.js";
import { requestJson, type RequestOptions } from "../../security/http.js";

// ---------------------------------------------------------------------------
// Contrat officiel AnySolver
//   POST https://api.anysolver.com/createTask
//   premier poll après 3–5 s, puis POST /getTaskResult toutes les 2–3 s
//   errorId peut être non-nul dans un HTTP 200 — il est vérifié à chaque fois.
// ---------------------------------------------------------------------------

export const ANYSOLVER_BASE = "https://api.anysolver.com";

export type DataDomeTaskType = "DataDomeInterstitialCookieTask" | "DataDomeSliderCookieTask";

export interface CreateTaskPayload {
  type: DataDomeTaskType;
  websiteURL: string;
  userAgent: string;
  /** Même proxy que le transport quand il y en a un — le cookie est lié au couple IP+UA. */
  proxy?: ReturnType<typeof toAnySolverProxy>;
  captchaURL?: string;
}

interface AnySolverResponse {
  errorId?: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: number;
  status?: string;
  solution?: Record<string, unknown>;
}

export class SolverError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly permanent = false
  ) {
    super(message);
    this.name = "SolverError";
  }
}

export interface SolveOptions {
  maxWaitMs?: number;
  onPoll?: (info: { poll: number; elapsedMs: number; status: string }) => void;
}

export interface SolvedChallenge {
  datadomeCookie: string;
  taskId: number;
  elapsedMs: number;
}

export class AnySolverClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: {
    apiKey: string;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    sleepImpl?: (ms: number) => Promise<void>;
  }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? ANYSOLVER_BASE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Un entier aléatoire dans [min, max] pour respecter les fenêtres de poll sans battement. */
  private static between(min: number, max: number): number {
    return min + Math.floor(Math.random() * (max - min));
  }

  private async post(path: string, body: Record<string, unknown>): Promise<AnySolverResponse> {
    const opts: RequestOptions = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: 30_000,
    };
    const res = await requestJson<AnySolverResponse>(`${this.baseUrl}${path}`, opts, this.fetchImpl);
    if (res.status < 200 || res.status >= 300) {
      throw new SolverError("http_error", `AnySolver HTTP ${res.status} sur ${path}`, res.status >= 500);
    }
    return res.json ?? {};
  }

  private static assertNoError(r: AnySolverResponse): void {
    if (r.errorId && r.errorId !== 0) {
      throw new SolverError(
        r.errorCode ?? "solver_error",
        `AnySolver: ${r.errorDescription ?? r.errorCode ?? "erreur inconnue"}`,
        /key|balance|banned|ip.*blocked/i.test(`${r.errorCode} ${r.errorDescription}`)
      );
    }
  }

  async balance(): Promise<number> {
    const r = await this.post("/getBalance", { clientKey: this.apiKey });
    AnySolverClient.assertNoError(r);
    return Number(r.solution?.balance ?? (r as unknown as { balance?: number }).balance ?? 0);
  }

  async solve(task: CreateTaskPayload, opts: SolveOptions = {}): Promise<SolvedChallenge> {
    const maxWaitMs = opts.maxWaitMs ?? 120_000;
    const started = Date.now();

    const created = await this.post("/createTask", {
      clientKey: this.apiKey,
      task: {
        type: task.type,
        websiteURL: task.websiteURL,
        userAgent: task.userAgent,
        ...(task.proxy ? { proxy: task.proxy } : {}),
        ...(task.captchaURL ? { captchaURL: task.captchaURL } : {}),
      },
    });
    AnySolverClient.assertNoError(created);
    if (!created.taskId) {
      throw new SolverError("no_task_id", "AnySolver n'a pas retourné de taskId", false);
    }
    const taskId = created.taskId;

    // Premier poll après 3–5 s — jamais avant
    await this.sleep(AnySolverClient.between(3000, 5000));

    let poll = 0;
    while (Date.now() - started < maxWaitMs) {
      poll++;
      const r = await this.post("/getTaskResult", { clientKey: this.apiKey, taskId });
      AnySolverClient.assertNoError(r);
      const status = r.status ?? "processing";
      opts.onPoll?.({ poll, elapsedMs: Date.now() - started, status });

      if (status === "ready") {
        const cookie = extractDatadome(r.solution);
        if (!cookie) {
          throw new SolverError("no_cookie", "Solution prête sans cookie datadome", false);
        }
        return { datadomeCookie: cookie, taskId, elapsedMs: Date.now() - started };
      }
      if (status === "failed") {
        throw new SolverError("task_failed", `Tâche AnySolver échouée (taskId ${taskId})`, false);
      }
      // processing → 2–3 s avant le poll suivant
      await this.sleep(AnySolverClient.between(2000, 3000));
    }
    throw new SolverError("timeout", `AnySolver: pas de solution en ${maxWaitMs} ms`, false);
  }
}

/** La solution peut être plat ou sous { cookies: { datadome } } selon le provider. */
export function extractDatadome(solution: Record<string, unknown> | undefined): string | null {
  if (!solution) return null;
  const direct = solution["datadome"] ?? solution["cookie"] ?? solution["datadomeCookie"];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const cookies = solution["cookies"];
  if (cookies && typeof cookies === "object") {
    const dd = (cookies as Record<string, unknown>)["datadome"];
    if (typeof dd === "string" && dd.length > 0) return dd;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fallback providers : TwoCaptcha (primaire) → RiskBypass / CapMonster
// CapSolver uniquement si le User-Agent choisi est dans leur liste acceptée.
// ---------------------------------------------------------------------------

export const PROVIDER_ORDER = ["TwoCaptcha", "RiskBypass", "CapMonster"] as const;
export type ProviderName = (typeof PROVIDER_ORDER)[number];

export function shouldFallback(
  currentProvider: ProviderName,
  err: SolverError
): ProviderName | null {
  if (!err.permanent) return null; // erreur transitoire → même provider, retry compté
  const idx = PROVIDER_ORDER.indexOf(currentProvider);
  for (let i = idx + 1; i < PROVIDER_ORDER.length; i++) {
    return PROVIDER_ORDER[i]!;
  }
  return null;
}

export { toAnySolverProxy };
