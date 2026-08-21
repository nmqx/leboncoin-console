import { FetchTransport } from "./adapters/leboncoin/transport.js";
import { parseProxy, type ProxyConfig } from "./domain/proxy.js";

/**
 * Diagnostics réseau. Backtest systématique : la même sonde est jouée
 * en direct ET via le proxy, pour comparer latence, IP de sortie et statut.
 * Les sondes passent par le transport (ProxyAgent undici), jamais par un
 * fetch nu — sinon le proxy est silencieusement contourné.
 */
export interface ProbeResult {
  ok: boolean;
  ip: string | null;
  status: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface StickyResult {
  sticky: boolean;
  probes: ProbeResult[];
  direct: ProbeResult | null;
  ips: string[];
}

const PROBE_URL = "https://api.ipify.org/?format=json";

async function probe(proxy?: ProxyConfig): Promise<ProbeResult> {
  const transport = new FetchTransport(proxy ? { proxy } : {});
  const t0 = Date.now();
  try {
    const res = await transport.request({ url: PROBE_URL, timeoutMs: 12_000 });
    let ip: string | null = null;
    try {
      ip = (JSON.parse(res.body) as { ip?: string }).ip ?? null;
    } catch {
      ip = null;
    }
    return {
      ok: res.status === 200 && !!ip,
      ip,
      status: res.status,
      latencyMs: Date.now() - t0,
      error: null,
    };
  } catch (err) {
    return { ok: false, ip: null, status: null, latencyMs: Date.now() - t0, error: (err as Error).message };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Test sticky : 3 sondes espacées via le même proxy. Si l'IP de sortie change,
 * le proxy est rotatif — l'activation doit être refusée pour les challenges
 * DataDome (le cookie est lié à l'IP). Joue aussi une sonde directe en regard.
 */
export async function stickyCheck(
  proxyRaw: string,
  opts: { probeCount?: number; gapMs?: number } = {}
): Promise<StickyResult> {
  const proxy = parseProxy(proxyRaw);
  const n = opts.probeCount ?? 3;
  const gap = opts.gapMs ?? 1500;

  const direct = await probe();

  const probes: ProbeResult[] = [];
  for (let i = 0; i < n; i++) {
    probes.push(await probe(proxy));
    if (i < n - 1) await sleep(gap);
  }
  const ips = [...new Set(probes.map((p) => p.ip).filter((ip): ip is string => !!ip))];
  return { sticky: ips.length === 1 && probes.every((p) => p.ok), probes, direct, ips };
}
