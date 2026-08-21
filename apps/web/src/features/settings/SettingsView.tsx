import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ShieldAlert, Upload, Zap, Wifi, KeyRound, LogOut, Chrome, Square, Activity } from "lucide-react";
import { api, ApiError } from "../../api";
import { dt, timeAgo } from "../../format";
import { Chip, Loading, Toggle } from "../../components/ui";

interface StickyResult {
  sticky: boolean;
  ips: string[];
  probes: Array<{ ok: boolean; ip: string | null; status: number | null; latencyMs: number | null; error: string | null }>;
  direct: { ok: boolean; ip: string | null; latencyMs: number | null } | null;
}

export default function SettingsView() {
  const qc = useQueryClient();
  const diagnostics = useQuery({ queryKey: ["diagnostics"], queryFn: api.diagnostics });
  const session = useQuery({ queryKey: ["session"], queryFn: api.sessionStatus });
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });

  // session
  const [manual, setManual] = useState({ luat: "", userId: "", userAgent: "" });
  const [sessionMsg, setSessionMsg] = useState<string | null>(null);
  const importSession = useMutation({
    mutationFn: () => api.sessionImport({ format: "manual", ...manual }),
    onSuccess: (res) => {
      setSessionMsg(`Session importée (coffre ${res.vault}) — expiration ${res.expiresAt ? dt(res.expiresAt) : "inconnue"}`);
      setManual({ luat: "", userId: "", userAgent: "" });
      void qc.invalidateQueries({ queryKey: ["session"] });
    },
    onError: (e) => setSessionMsg(e instanceof ApiError ? e.message : (e as Error).message),
  });
  const deleteSession = useMutation({
    mutationFn: api.sessionDelete,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["session"] }),
  });

  // proxy
  const [proxyInput, setProxyInput] = useState("");
  const [sticky, setSticky] = useState<StickyResult | null>(null);
  const stickyTest = useMutation({
    mutationFn: (save: boolean) => api.proxySticky(proxyInput.trim() || undefined, save),
    onSuccess: (res) => setSticky(res),
  });

  // anysolver
  const [anysolverKey, setAnysolverKey] = useState("");
  const [anysolverBalance, setAnysolverBalance] = useState<number | null>(null);
  const anysolverTest = useMutation({
    mutationFn: () => api.anysolverCheck(anysolverKey.trim() || undefined),
    onSuccess: (res) => {
      setAnysolverBalance(res.balance);
      void qc.invalidateQueries({ queryKey: ["diagnostics"] });
    },
  });

  // llm
  const [llmKey, setLlmKey] = useState("");
  const [llmResult, setLlmResult] = useState<string | null>(null);
  const saveLlmKey = useMutation({
    mutationFn: () => api.llmKey(llmKey.trim()),
    onSuccess: () => {
      setLlmKey("");
      void qc.invalidateQueries({ queryKey: ["diagnostics"] });
    },
  });
  const llmTest = useMutation({
    mutationFn: api.llmCheck,
    onSuccess: (res) => setLlmResult(`OK — ${res.model} · ${res.latencyMs} ms · « ${res.sample} »`),
    onError: (e) => setLlmResult(e instanceof ApiError ? `${e.code} : ${e.message}` : (e as Error).message),
  });

  // ---------------------------------------------------------------- chrome
  const chrome = useQuery({ queryKey: ["chrome"], queryFn: api.chromeStatus, refetchInterval: (q) => (q.state.data?.running ? 4000 : 15000) });
  const captured = useQuery({ queryKey: ["captured"], queryFn: () => api.capturedRequests(), refetchInterval: (q) => (q.state.data?.captured.length ? 10000 : 15000) });
  const chromeStart = useMutation({
    mutationFn: api.chromeStart,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["chrome"] }),
  });
  const chromeFinish = useMutation({
    mutationFn: api.chromeFinish,
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["chrome"] });
      void qc.invalidateQueries({ queryKey: ["session"] });
      void qc.invalidateQueries({ queryKey: ["captured"] });
      setSessionMsg(
        res.imported
          ? `Session importée depuis Chrome (user ${res.userId ?? "?"}, expiration ${res.expiresAt ? dt(res.expiresAt) : "inconnue"}, ${res.capturedCount} requêtes capturées)`
          : `Cookie luat introuvable — connectez-vous vraiment à Leboncoin avant de terminer (${res.capturedCount} requêtes capturées)`
      );
    },
    onError: (e) => setSessionMsg(e instanceof ApiError ? e.message : (e as Error).message),
  });

  // ---------------------------------------------------------------- routage
  const routing = useQuery({ queryKey: ["routing"], queryFn: api.routing });
  const [routingDraft, setRoutingDraft] = useState<{ search: "direct" | "proxy"; messaging: "direct" | "proxy" } | null>(null);
  const routingValue = routingDraft ?? routing.data ?? { search: "direct" as const, messaging: "direct" as const };
  const saveRouting = useMutation({
    mutationFn: (r: { search: "direct" | "proxy"; messaging: "direct" | "proxy" }) => api.setRouting(r),
    onSuccess: () => {
      setRoutingDraft(null);
      void qc.invalidateQueries({ queryKey: ["routing"] });
    },
  });

  // ---------------------------------------------------------------- stress
  const [stressResult, setStressResult] = useState<Array<{ leg: string; count: number; ok200: number; datadome: number; other: number; p50Ms: number | null; p95Ms: number | null }>>([]);
  const [stressBusy, setStressBusy] = useState(false);
  const runStress = async (count: number) => {
    setStressBusy(true);
    setStressResult([]);
    try {
      const direct = await api.stress(count, false);
      setStressResult((r) => [...r, direct]);
      const proxied = await api.stress(count, true).catch(() => null);
      if (proxied) setStressResult((r) => [...r, proxied]);
    } finally {
      setStressBusy(false);
    }
  };

  // automation & kill switch
  const setAutomation = useMutation({
    mutationFn: (on: boolean) => (on ? api.automation.enable() : api.automation.disable()),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["status"] }),
  });
  const setKill = useMutation({
    mutationFn: (on: boolean) => api.killSwitch(on),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["status"] }),
  });

  if (diagnostics.isPending) return <Loading />;

  const httpWarning = "L'API LLM utilise HTTP non chiffré. Les messages et la clé peuvent être interceptés.";

  return (
    <>
      <div className="view-head">
        <h1>Système</h1>
        <Chip cls={status.data?.mode === "live" ? "accent" : "info"}>mode {status.data?.mode ?? "…"}</Chip>
        <span className="muted" style={{ fontSize: 11 }}>coffre : {diagnostics.data?.vault === "dpapi" ? "DPAPI CurrentUser" : "dev (hors production)"}</span>
      </div>

      <div className="settings">
        {diagnostics.data?.llmConfigured ? (
          <div className="banner" role="alert">
            <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{httpWarning}</span>
          </div>
        ) : null}

        {/* ------------------------------------------------ session */}
        <section className="panel" style={{ padding: 14 }}>
          <div className="panel-title" style={{ padding: 0, marginBottom: 10 }}>Session Leboncoin</div>
          {session.data?.imported ? (
            <>
              <dl className="kv" style={{ display: "grid", gridTemplateColumns: "130px 1fr", gap: 4, marginBottom: 10 }}>
                <dt className="muted">Utilisateur</dt><dd>{session.data.userId ?? "—"}</dd>
                <dt className="muted">User-Agent</dt><dd className="mono" style={{ fontSize: 10.5 }}>{session.data.userAgent ?? "—"}</dd>
                <dt className="muted">Expiration JWT</dt>
                <dd>
                  {dt(session.data.expiresAt)}{" "}
                  {session.data.expiresSoon ? <Chip cls="coral">expire bientôt</Chip> : <Chip cls="accent">valide</Chip>}
                </dd>
              </dl>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="btn danger" onClick={() => deleteSession.mutate()}><LogOut size={13} />Supprimer la session</button>
              </div>
            </>
          ) : (
            <>
              <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
                Import du cookie <span className="mono">luat</span> (JWT), de l'identifiant et du User-Agent. Chiffré DPAPI, jamais réaffiché. Aucun mot de passe.
              </p>
              <div className="row">
                <label className="field" style={{ flex: 2, minWidth: 260 }}>Cookie luat (JWT)
                  <input type="password" value={manual.luat} onChange={(e) => setManual({ ...manual, luat: e.target.value })} placeholder="eyJ…" />
                </label>
                <label className="field">lbc_user_id
                  <input type="text" value={manual.userId} onChange={(e) => setManual({ ...manual, userId: e.target.value })} placeholder="12345678" />
                </label>
                <label className="field" style={{ flex: 2, minWidth: 220 }}>User-Agent
                  <input type="text" value={manual.userAgent} onChange={(e) => setManual({ ...manual, userAgent: e.target.value })} placeholder="Mozilla/5.0 …" />
                </label>
                <button type="button" className="btn primary" disabled={importSession.isPending || !manual.luat || !manual.userId || !manual.userAgent} onClick={() => importSession.mutate()}>
                  <Upload size={13} />Importer
                </button>
              </div>
            </>
          )}
          {sessionMsg ? <p style={{ fontSize: 11.5, marginTop: 8, color: "var(--text-2)" }}>{sessionMsg}</p> : null}
        </section>

        {/* ------------------------------------------------ chrome login */}
        <section className="panel" style={{ padding: 14 }}>
          <div className="panel-title" style={{ padding: 0, marginBottom: 10 }}>Connexion Chrome — capture DevTools</div>
          <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            Chrome réel, profil dédié, piloté par vous. On écoute le réseau (CDP) : cookies de session + contrats
            de requêtes messagerie (inbox, envoi). Aucun Playwright, aucun pilotage de page.
          </p>
          <div className="row">
            {chrome.data?.running ? (
              <>
                <Chip cls="accent">capture en cours · port {chrome.data.status?.port} · {chrome.data.status?.capturedCount ?? 0} requêtes</Chip>
                <span style={{ flex: 1 }} />
                <button type="button" className="btn primary" disabled={chromeFinish.isPending} onClick={() => chromeFinish.mutate()}>
                  <Square size={13} />{chromeFinish.isPending ? "Import…" : "Terminer & importer"}
                </button>
              </>
            ) : (
              <button type="button" className="btn primary" disabled={chromeStart.isPending} onClick={() => chromeStart.mutate()}>
                <Chrome size={14} />{chromeStart.isPending ? "Lancement…" : "Ouvrir Chrome & se connecter"}
              </button>
            )}
          </div>
          {chrome.data && chrome.data.captured.length > 0 ? (
            <div style={{ marginTop: 10, maxHeight: 200, overflowY: "auto" }}>
              <table className="probes">
                <thead><tr><th>Méthode</th><th>URL</th><th>Type</th><th>Statut</th><th>Quand</th></tr></thead>
                <tbody>
                  {chrome.data.captured.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">{c.method}</td>
                      <td className="mono" style={{ maxWidth: 340, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.url}</td>
                      <td><Chip cls={c.kind === "send" ? "accent" : c.kind === "inbox" ? "info" : null}>{c.kind}</Chip></td>
                      <td>{c.status ?? "—"}</td>
                      <td className="muted" title={dt(c.capturedAt)}>{timeAgo(c.capturedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {session.data?.imported ? (
            <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
              Session active importée — l'inbox live rejoue ces contrats via requêtes directes (politique ci-dessous).
            </p>
          ) : null}
        </section>

        {/* ------------------------------------------------ routage */}
        <section className="panel" style={{ padding: 14 }}>
          <div className="panel-title" style={{ padding: 0, marginBottom: 10 }}>Routage réseau — proxy ou direct, par flux</div>
          <div className="row">
            <label className="field">Recherche (annonces)
              <select
                value={routingValue.search}
                disabled={saveRouting.isPending}
                onChange={(e) => saveRouting.mutate({ ...routingValue, search: e.target.value as "direct" | "proxy" })}
              >
                <option value="direct">Direct (IP maison)</option>
                <option value="proxy">Via le proxy stocké</option>
              </select>
            </label>
            <label className="field">Messagerie (inbox, envois)
              <select
                value={routingValue.messaging}
                disabled={saveRouting.isPending}
                onChange={(e) => saveRouting.mutate({ ...routingValue, messaging: e.target.value as "direct" | "proxy" })}
              >
                <option value="direct">Direct — recommandé pour le compte</option>
                <option value="proxy">Via le proxy stocké</option>
              </select>
            </label>
            {saveRouting.isSuccess && !routingDraft ? <Chip cls="accent">appliqué</Chip> : null}
          </div>
          <p className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
            Le cookie de session et le datadome restent liés au couple IP + User-Agent : gardez la messagerie sur l'IP
            qui a fait la connexion Chrome.
          </p>
        </section>

        {/* ------------------------------------------------ stress */}
        <section className="panel" style={{ padding: 14 }}>
          <div className="panel-title" style={{ padding: 0, marginBottom: 10 }}>Stress test — N requêtes, direct puis proxy</div>
          <div className="row">
            <button type="button" className="btn" disabled={stressBusy} onClick={() => void runStress(12)}>
              <Activity size={13} />{stressBusy ? "En cours…" : "Lancer 12 + 12"}
            </button>
            {stressResult.length > 0 ? (
              <table className="probes" style={{ flex: 1 }}>
                <thead><tr><th>Bras</th><th>200</th><th>DataDome</th><th>Autres</th><th>p50</th><th>p95</th></tr></thead>
                <tbody>
                  {stressResult.map((r) => (
                    <tr key={r.leg}>
                      <td>{r.leg === "proxy" ? "via proxy" : "direct"}</td>
                      <td>{r.ok200}/{r.count}</td>
                      <td style={{ color: r.datadome > 0 ? "var(--coral)" : undefined }}>{r.datadome}</td>
                      <td>{r.other}</td>
                      <td className="num">{r.p50Ms !== null ? `${r.p50Ms} ms` : "—"}</td>
                      <td className="num">{r.p95Ms !== null ? `${r.p95Ms} ms` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <span className="muted" style={{ fontSize: 11.5 }}>Vérifie que l'empreinte Chrome 131 tient sous rafale, avec et sans proxy.</span>
            )}
          </div>
        </section>

        {/* ------------------------------------------------ proxy */}
        <section className="panel" style={{ padding: 14 }}>
          <div className="panel-title" style={{ padding: 0, marginBottom: 10 }}>Proxy — backtest direct vs proxy</div>
          <div className="row">
            <label className="field" style={{ flex: 1, minWidth: 300 }}>Proxy (host:port:user:pass ou user:pass@host:port)
              <input type="text" value={proxyInput} onChange={(e) => setProxyInput(e.target.value)} placeholder="user:pass@proxy.example.com:8080" />
            </label>
            <button type="button" className="btn" disabled={stickyTest.isPending || (!proxyInput.trim() && !diagnostics.data?.proxyConfigured)} onClick={() => stickyTest.mutate(false)}>
              <Wifi size={13} />{stickyTest.isPending ? "Sondes en cours…" : "Tester (3 sondes + direct)"}
            </button>
            <button type="button" className="btn primary" disabled={!proxyInput.trim()} onClick={() => stickyTest.mutate(true)}>Stocker chiffré</button>
          </div>
          {diagnostics.data && !sticky ? (
            <p className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
              Proxy stocké : {diagnostics.data.proxyConfigured ? "oui (chiffré)" : "non"}
            </p>
          ) : null}
          {sticky ? (
            <div style={{ marginTop: 10 }}>
              {sticky.sticky ? (
                <Chip cls="accent">sticky confirmé — IP unique {sticky.ips[0]}</Chip>
              ) : (
                <Chip cls="coral">rotatif ou défaillant — {sticky.ips.length} IP vues : refusé pour DataDome</Chip>
              )}
              <table className="probes" style={{ marginTop: 8 }}>
                <thead>
                  <tr><th>Chemin</th><th>OK</th><th>IP sortie</th><th>HTTP</th><th>Latence</th><th>Erreur</th></tr>
                </thead>
                <tbody>
                  {sticky.direct ? (
                    <tr>
                      <td>direct (sans proxy)</td>
                      <td>{sticky.direct.ok ? "✓" : "✗"}</td>
                      <td className="mono">{sticky.direct.ip ?? "—"}</td>
                      <td>{sticky.direct.ok ? "200" : "—"}</td>
                      <td className="num">{sticky.direct.latencyMs ?? "—"} ms</td>
                      <td>—</td>
                    </tr>
                  ) : null}
                  {sticky.probes.map((p, i) => (
                    <tr key={i}>
                      <td>proxy — sonde {i + 1}</td>
                      <td>{p.ok ? "✓" : "✗"}</td>
                      <td className="mono">{p.ip ?? "—"}</td>
                      <td>{p.status ?? "—"}</td>
                      <td className="num">{p.latencyMs ?? "—"} ms</td>
                      <td>{p.error ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>

        {/* ------------------------------------------------ anysolver */}
        <section className="panel" style={{ padding: 14 }}>
          <div className="panel-title" style={{ padding: 0, marginBottom: 10 }}>AnySolver — DataDome</div>
          <div className="row">
            <label className="field" style={{ flex: 1, minWidth: 260 }}>Clé API
              <input type="password" value={anysolverKey} onChange={(e) => setAnysolverKey(e.target.value)} placeholder={diagnostics.data?.anysolverConfigured ? "•••• (déjà stockée)" : "clé AnySolver"} />
            </label>
            <button type="button" className="btn" disabled={anysolverTest.isPending} onClick={() => anysolverTest.mutate()}>
              <Zap size={13} />{anysolverTest.isPending ? "…" : "Vérifier solde"}
            </button>
          </div>
          {anysolverBalance !== null ? (
            <p style={{ marginTop: 8, fontSize: 12 }}>Solde : <strong>{anysolverBalance.toFixed(2)} $</strong> · budget défaut : 100 challenges/jour, 2 tentatives max par job</p>
          ) : (
            <p className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>Provider primaire TwoCaptcha, fallback RiskBypass. CapSolver réservé aux User-Agent acceptés.</p>
          )}
          {anysolverTest.isError ? <p style={{ color: "var(--coral)", fontSize: 11.5, marginTop: 6 }}>{(anysolverTest.error as Error).message}</p> : null}
        </section>

        {/* ------------------------------------------------ llm */}
        <section className="panel" style={{ padding: 14 }}>
          <div className="panel-title" style={{ padding: 0, marginBottom: 10 }}>LLM — réponses automatiques</div>
          <div className="banner" role="alert" style={{ marginBottom: 10 }}>
            <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{httpWarning}</span>
          </div>
          <div className="row">
            <label className="field" style={{ flex: 1, minWidth: 260 }}>Clé API
              <input type="password" value={llmKey} onChange={(e) => setLlmKey(e.target.value)} placeholder={diagnostics.data?.llmConfigured ? "•••• (déjà stockée)" : "clé gateway"} />
            </label>
            <button type="button" className="btn" disabled={!llmKey.trim() || saveLlmKey.isPending} onClick={() => saveLlmKey.mutate()}>Stocker chiffré</button>
            <button type="button" className="btn" disabled={!diagnostics.data?.llmConfigured || llmTest.isPending} onClick={() => llmTest.mutate()}>
              <KeyRound size={13} />{llmTest.isPending ? "…" : "Tester"}
            </button>
          </div>
          {llmResult ? <p style={{ marginTop: 8, fontSize: 12 }}>{llmResult}</p> : null}
          <p className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>Modèle gemini-3.7-flash-high · 512 tokens · temp. 0.3 · réponses validées (JSON, ≤ 500 car., zéro secret) avant envoi</p>
        </section>

        {/* ------------------------------------------------ automation */}
        <section className="panel" style={{ padding: 14 }}>
          <div className="panel-title" style={{ padding: 0, marginBottom: 10 }}>Automation & arrêt d'urgence</div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
              <Toggle on={status.data?.automation.enabled ?? false} label="Automation" onChange={(v) => setAutomation.mutate(v)} />
              Réponses automatiques (10/h/conversation · 100/jour · débounce 20 s)
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: (status.data?.automation.killSwitch ?? false) ? "var(--coral)" : undefined }}>
              <Toggle on={status.data?.automation.killSwitch ?? false} label="Kill switch" onChange={(v) => setKill.mutate(v)} />
              <ShieldAlert size={14} />Kill switch — suspend tout (jobs, envois)
            </label>
          </div>
        </section>

        {/* ------------------------------------------------ rétention */}
        <section className="panel" style={{ padding: 14 }}>
          <div className="panel-title" style={{ padding: 0, marginBottom: 10 }}>Rétention & maintenance</div>
          <div className="grid2">
            <div><Chip>annonces 180 j</Chip></div>
            <div><Chip>messages 90 j</Chip></div>
            <div><Chip>événements, livraisons, logs 30 j</Chip></div>
            <div><Chip>base SQLite WAL locale</Chip></div>
          </div>
        </section>
      </div>
    </>
  );
}
