import { describe, it, expect, vi } from "vitest";
import { AnySolverClient, extractDatadome, shouldFallback, SolverError, type CreateTaskPayload } from "../../apps/server/src/adapters/anysolver/client.js";

const task: CreateTaskPayload = {
  type: "DataDomeInterstitialCookieTask",
  websiteURL: "https://www.leboncoin.fr/recherche",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131",
  proxy: { type: "http", host: "p.io", port: 8080, username: "u", password: "p" },
};

function mockFetch(responses: Array<{ status: number; body: unknown }>) {
  let call = 0;
  const urls: string[] = [];
  const fn = vi.fn(async (url: string | URL) => {
    urls.push(String(url));
    const r = responses[Math.min(call, responses.length - 1)]!;
    call++;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, urls };
}

const fastSleep = () => Promise.resolve();

describe("AnySolverClient.solve", () => {
  it("premier poll après 3–5 s puis ready → cookie datadome", async () => {
    const { fn } = mockFetch([
      { status: 200, body: { errorId: 0, taskId: 777 } },        // createTask
      { status: 200, body: { errorId: 0, status: "processing" } }, // poll 1
      { status: 200, body: { errorId: 0, status: "processing" } }, // poll 2
      { status: 200, body: { errorId: 0, status: "ready", solution: { datadome: "dd_cookie_abc" } } },
    ]);
    const sleeps: number[] = [];
    const client = new AnySolverClient({
      apiKey: "KEY",
      fetchImpl: fn,
      sleepImpl: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    const result = await client.solve(task);
    expect(result.datadomeCookie).toBe("dd_cookie_abc");
    expect(result.taskId).toBe(777);
    expect(fn).toHaveBeenCalledTimes(4);
    // premier délai ∈ [3000, 5000], suivants ∈ [2000, 3000]
    expect(sleeps[0]).toBeGreaterThanOrEqual(3000);
    expect(sleeps[0]).toBeLessThanOrEqual(5000);
    for (const s of sleeps.slice(1)) {
      expect(s).toBeGreaterThanOrEqual(2000);
      expect(s).toBeLessThanOrEqual(3000);
    }
  });

  it("errorId non nul dans un HTTP 200 → SolverError (jamais ignoré)", async () => {
    const { fn } = mockFetch([
      { status: 200, body: { errorId: 1, errorCode: "ERROR_KEY_DOES_NOT_EXIST", errorDescription: "clé invalide" } },
    ]);
    const client = new AnySolverClient({ apiKey: "BAD", fetchImpl: fn, sleepImpl: fastSleep });
    await expect(client.solve(task)).rejects.toThrow(SolverError);
  });

  it("status failed → erreur explicite", async () => {
    const { fn } = mockFetch([
      { status: 200, body: { errorId: 0, taskId: 1 } },
      { status: 200, body: { errorId: 0, status: "failed" } },
    ]);
    const client = new AnySolverClient({ apiKey: "KEY", fetchImpl: fn, sleepImpl: fastSleep });
    await expect(client.solve(task)).rejects.toThrow(/échouée/);
  });

  it("ready sans cookie → erreur", async () => {
    const { fn } = mockFetch([
      { status: 200, body: { errorId: 0, taskId: 1 } },
      { status: 200, body: { errorId: 0, status: "ready", solution: { foo: 1 } } },
    ]);
    const client = new AnySolverClient({ apiKey: "KEY", fetchImpl: fn, sleepImpl: fastSleep });
    await expect(client.solve(task)).rejects.toThrow(/sans cookie/);
  });

  it("timeout → SolverError transitoire (même provider au retry)", async () => {
    const { fn } = mockFetch([
      { status: 200, body: { errorId: 0, taskId: 1 } },
      { status: 200, body: { errorId: 0, status: "processing" } },
    ]);
    const client = new AnySolverClient({ apiKey: "KEY", fetchImpl: fn, sleepImpl: fastSleep });
    await expect(client.solve(task, { maxWaitMs: 0 })).rejects.toMatchObject({
      code: "timeout",
      permanent: false,
    });
  });
});

describe("extractDatadome", () => {
  it("lit la solution plate ou imbriquée", () => {
    expect(extractDatadome({ datadome: "x" })).toBe("x");
    expect(extractDatadome({ cookies: { datadome: "y" } })).toBe("y");
    expect(extractDatadome({ rien: 1 })).toBeNull();
    expect(extractDatadome(undefined)).toBeNull();
  });
});

describe("fallback providers", () => {
  it("erreur permanente → provider suivant ; transitoire → rester", () => {
    expect(shouldFallback("TwoCaptcha", new SolverError("ERROR_KEY_DOES_NOT_EXIST", "bad key", true))).toBe("RiskBypass");
    expect(shouldFallback("RiskBypass", new SolverError("ERROR_ZERO_BALANCE", "no funds", true))).toBe("CapMonster");
    expect(shouldFallback("TwoCaptcha", new SolverError("ERROR_NETWORK", "temporary", false))).toBeNull();
  });
});
