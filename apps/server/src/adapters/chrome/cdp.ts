import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { requestJson } from "../../security/http.js";
import { logger } from "../../logger.js";

// ---------------------------------------------------------------------------
// Client CDP minimal — WebSocket natif Node 24, aucun puppeteer/playwright.
// Le compte ne voit qu'un Chrome ordinaire piloté par son propriétaire.
// ---------------------------------------------------------------------------

export class CdpClient {
  private ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>();

  private constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    this.ws.onmessage = (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: Record<string, unknown>;
        error?: { message: string };
      };
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(`CDP ${msg.error.message}`));
        // les réponses de commande sont dans "result", "params" est pour les événements
        else p?.resolve(msg.result ?? msg.params ?? {});
      } else if (msg.method) {
        for (const cb of this.listeners.get(msg.method) ?? []) cb(msg.params ?? {});
      }
    };
  }

  static async connect(wsUrl: string, timeoutMs = 8000): Promise<CdpClient> {
    const client = new CdpClient(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`CDP connect timeout : ${wsUrl}`)), timeoutMs);
      client.ws.onopen = () => { clearTimeout(t); resolve(); };
      client.ws.onerror = () => { clearTimeout(t); reject(new Error(`CDP connect échoué : ${wsUrl}`)); };
    });
    return client;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} timeout`));
      }, 15_000);
    }) as Promise<Record<string, unknown>>;
  }

  on(event: string, cb: (params: Record<string, unknown>) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(cb);
    this.listeners.set(event, arr);
  }

  close(): void {
    try { this.ws.close(); } catch { /* déjà fermée */ }
  }
}

// ---------------------------------------------------------------------------
// Lancement Chrome avec DevTools — profil dédié, jamais le profil principal
// ---------------------------------------------------------------------------

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe") : "",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

export function findChrome(): string {
  for (const p of CHROME_CANDIDATES) {
    if (p && existsSync(p)) return p;
  }
  throw new Error("Chrome (ou Edge) introuvable — installez Chrome ou ajustez CHROME_PATH");
}

export interface ChromeHandle {
  process: ChildProcess;
  port: number;
  profileDir: string;
  browserWsUrl: string;
}

/** Tue tout chrome.exe dont la ligne de commande référence ce profil. */
async function killChromeOnProfile(profileDir: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  // -like : seuls * et ? sont des jokers, l'antislash n'est PAS un escape —
  // on échappe uniquement les quotes et on remplace les jokers du chemin
  const pattern = `*${profileDir.replace(/'/g, "''").replace(/[[*?]/g, "`$&")}*`;
  const ps = `
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
      Where-Object { $_.CommandLine -like '${pattern}' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  `;
  try {
    await run("powershell.exe", ["-NoProfile", "-Command", ps], { timeout: 15_000 });
    await new Promise((r) => setTimeout(r, 800));
  } catch { /* powershell absent ou rien à tuer */ }
}

export async function launchChromeDebug(opts: {
  port?: number;
  profileDir: string;
  startUrl: string;
  extraArgs?: string[];
}): Promise<ChromeHandle> {
  // port décalé aléatoirement : évite les collisions avec un débogueur
  // précédent encore en écoute ou un Chrome qui traîne
  const port = opts.port ?? 9223 + Math.floor(Math.random() * 100);
  const exe = process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : findChrome();
  // Chemin ABSOLU obligatoire : un --user-data-dir relatif fait ignorer
  // silencieusement --remote-debugging-port par Chrome (reproduit et vérifié)
  const profileDir = resolve(opts.profileDir);
  mkdirSync(profileDir, { recursive: true });

  // Un Chrome déjà ouvert sur ce profil ferait dévier le nouveau processus vers
  // l'instance existante (sans port DevTools) — on nettoie d'abord.
  await killChromeOnProfile(profileDir);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--start-maximized",
    ...(opts.extraArgs ?? []),
    opts.startUrl,
  ];
  const child = spawn(exe, args, { detached: true, stdio: "ignore" });
  child.unref();

  // attendre que le port DevTools réponde — démarrage à froid jusqu'à ~40 s
  // (un profil vierge + dialogues de premier lancement peuvent être lents)
  let browserWsUrl = "";
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await requestJson<{ webSocketDebuggerUrl?: string }>(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 2500 });
      if (res.json?.webSocketDebuggerUrl) {
        browserWsUrl = res.json.webSocketDebuggerUrl;
        break;
      }
    } catch { /* pas encore prêt */ }
  }
  if (!browserWsUrl) {
    try { child.kill(); } catch { /* déjà parti */ }
    throw new Error("Chrome démarré mais DevTools inaccessible après 45 s");
  }
  logger.info({ port }, "Chrome DevTools prêt");
  return { process: child, port, profileDir, browserWsUrl };
}

export interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export async function listTargets(port: number): Promise<CdpTarget[]> {
  const res = await requestJson<CdpTarget[]>(`http://127.0.0.1:${port}/json/list`, { timeoutMs: 3000 });
  return res.json ?? [];
}

/** Onglet Leboncoin ouvert ? sinon premier onglet de type page. */
export async function pickLbcTarget(port: number): Promise<CdpTarget | null> {
  const targets = await listTargets(port);
  return (
    targets.find((t) => t.type === "page" && /leboncoin\.fr/i.test(t.url) && t.webSocketDebuggerUrl) ??
    targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ??
    null
  );
}

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
}

export async function getAllCookies(browser: CdpClient, page?: CdpClient | null): Promise<CdpCookie[]> {
  const errors: string[] = [];
  // 1. Storage.getCookies sur la cible navigateur — peut résoudre vide selon la
  //    version de Chrome : une réponse sans cookies n'est pas un succès
  try {
    const res = (await browser.send("Storage.getCookies")) as { cookies?: CdpCookie[] };
    if (res.cookies && res.cookies.length > 0) return res.cookies;
    errors.push("browser/Storage.getCookies: réponse vide");
  } catch (e) {
    errors.push(`browser/Storage.getCookies: ${(e as Error).message}`);
  }
  // 2. Storage.getCookies sur la cible page
  if (page) {
    try {
      const res = (await page.send("Storage.getCookies")) as { cookies?: CdpCookie[] };
      if (res.cookies && res.cookies.length > 0) return res.cookies;
      errors.push("page/Storage.getCookies: réponse vide");
    } catch (e) {
      errors.push(`page/Storage.getCookies: ${(e as Error).message}`);
    }
    // 3. Network.getCookies borné aux domaines Leboncoin
    try {
      const res = (await page.send("Network.getCookies", {
        urls: ["https://www.leboncoin.fr", "https://api.leboncoin.fr"],
      })) as { cookies?: CdpCookie[] };
      if (res.cookies && res.cookies.length > 0) return res.cookies;
      errors.push("page/Network.getCookies: réponse vide");
    } catch (e) {
      errors.push(`page/Network.getCookies: ${(e as Error).message}`);
    }
  } else {
    errors.push("cible page non attachée");
  }
  throw new Error(`collecte cookies impossible — ${errors.join(" | ")}`);
}
