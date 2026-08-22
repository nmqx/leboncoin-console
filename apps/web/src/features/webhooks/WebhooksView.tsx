import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, FlaskConical, RotateCcw, Trash2, X } from "lucide-react";
import type { Webhook, Delivery } from "@lbc/contracts";
import { api, ApiError } from "../../api";
import { dt, timeAgo } from "../../format";
import { Chip, EmptyState, ErrorState, Loading, Toggle } from "../../components/ui";

const ALL_EVENTS = [
  "listing.created", "listing.price_changed", "watch.completed",
  "message.received", "reply.sent", "reply.failed", "challenge.failed", "session.expiring",
] as const;

const STATUS_CHIP: Record<string, "accent" | "amber" | "coral" | null> = {
  delivered: "accent",
  pending: "amber",
  failed: "coral",
  dead: "coral",
};

export default function WebhooksView() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["webhooks"], queryFn: api.webhooks });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ kind: "discord" as "discord" | "http", url: "", secret: "", events: ["listing.created", "listing.price_changed"] as string[] });
  const [formError, setFormError] = useState<string | null>(null);

  const deliveries = useQuery({
    queryKey: ["deliveries", selectedId],
    queryFn: () => api.deliveries(selectedId!),
    enabled: !!selectedId,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["webhooks"] });
    void qc.invalidateQueries({ queryKey: ["deliveries"] });
  };

  const create = useMutation({
    mutationFn: () => api.createWebhook(form.kind, form.url.trim(), form.events, form.kind === "http" ? form.secret : undefined),
    onSuccess: () => {
      invalidate();
      setCreateOpen(false);
      setForm({ ...form, url: "", secret: "" });
      setFormError(null);
    },
    onError: (err) => setFormError(err instanceof ApiError ? err.message : (err as Error).message),
  });

  const test = useMutation({ mutationFn: api.testWebhook, onSuccess: invalidate });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => api.updateWebhook(id, { enabled }),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: api.deleteWebhook, onSuccess: invalidate });
  const replay = useMutation({ mutationFn: api.replayDelivery, onSuccess: invalidate });

  const webhooks: Webhook[] = list.data?.webhooks ?? [];
  const selected = webhooks.find((w) => w.id === selectedId) ?? null;
  const dels: Delivery[] = deliveries.data?.deliveries ?? [];

  useEffect(() => {
    if (!createOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCreateOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [createOpen]);

  return (
    <>
      <div className="view-head">
        <h1>Webhooks</h1>
        <span className="muted" style={{ fontSize: 11 }}>outbox SQLite · backoff 1 → 5 → 30 min → 2 h · dead-letter</span>
        <span className="spacer" />
        <button type="button" className="btn primary" onClick={() => setCreateOpen(true)}><Plus size={14} />Ajouter</button>
      </div>

      {createOpen ? (
        <div className="overlay dialog-scrim" onClick={() => setCreateOpen(false)} role="dialog" aria-modal="true" aria-label="Nouveau webhook">
          <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ width: 640 }}>
            <header className="dialog-head">
              <span>Nouveau webhook</span>
              <button type="button" className="btn subtle icon" onClick={() => setCreateOpen(false)} aria-label="Fermer"><X size={15} /></button>
            </header>
            <div className="dialog-body">
              <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 12, alignItems: "end" }}>
                <label className="field">Type
                  <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as "discord" | "http" })}>
                    <option value="discord">Discord</option>
                    <option value="http">HTTP (HMAC)</option>
                  </select>
                </label>
                <label className="field">URL
                  <input type="text" placeholder={form.kind === "discord" ? "https://discord.com/api/webhooks/…" : "https://exemple.fr/hook"} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
                </label>
              </div>
              {form.kind === "http" ? (
                <label className="field" style={{ marginTop: 12 }}>Secret HMAC
                  <input type="password" placeholder="≥ 16 caractères" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} />
                </label>
              ) : null}
              <div style={{ marginTop: 14 }}>
                <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>Événements</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {ALL_EVENTS.map((ev) => (
                    <button
                      key={ev}
                      type="button"
                      className={`chip${form.events.includes(ev) ? " accent" : ""}`}
                      style={{ cursor: "pointer" }}
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          events: f.events.includes(ev) ? f.events.filter((x) => x !== ev) : [...f.events, ev],
                        }))
                      }
                    >
                      {ev}
                    </button>
                  ))}
                </div>
              </div>
              {formError ? <div className="banner coral" style={{ marginTop: 12 }}>{formError}</div> : null}
            </div>
            <footer className="dialog-actions">
              <button type="button" className="btn subtle" onClick={() => setCreateOpen(false)}>Annuler</button>
              <button type="button" className="btn primary" disabled={!form.url.trim() || create.isPending} onClick={() => create.mutate()}>Créer</button>
            </footer>
          </div>
        </div>
      ) : null}

      <div className="view-body" style={{ flexDirection: "column" }}>
        {list.isPending ? <Loading /> :
         list.isError ? <ErrorState error={{ code: "Erreur", message: (list.error as Error).message }} onRetry={() => void list.refetch()} /> :
         webhooks.length === 0 ? (
           <EmptyState title="Aucun webhook" hint={<>Ajoutez un webhook Discord pour recevoir les nouvelles annonces et alertes.</>} />
         ) : (
          <div className="table-wrap" style={{ maxHeight: "45%" }}>
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: 34 }}></th>
                  <th style={{ width: 80 }}>Type</th>
                  <th>URL</th>
                  <th>Événements</th>
                  <th style={{ width: 90 }}>Créé</th>
                  <th style={{ width: 150 }}></th>
                </tr>
              </thead>
              <tbody>
                {webhooks.map((w) => (
                  <tr key={w.id} className={w.id === selectedId ? "selected" : ""} onClick={() => setSelectedId(w.id)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <Toggle on={w.enabled} label={`Activer webhook ${w.id}`} onChange={(enabled) => toggle.mutate({ id: w.id, enabled })} />
                    </td>
                    <td><Chip cls={w.kind === "discord" ? "info" : null}>{w.kind}</Chip></td>
                    <td className="mono" style={{ maxWidth: 380 }}>{w.url.replace(/(webhooks\/\d+\/).+/, "$1***")}</td>
                    <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {w.hasSecret ? <span className="chip" style={{ marginRight: 4 }}>HMAC</span> : null}
                      <span className="muted">{w.events.join(", ")}</span>
                    </td>
                    <td className="muted" title={dt(w.createdAt)}>{timeAgo(w.createdAt)}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                      <button type="button" className="btn subtle icon" title="Envoyer un événement de test" onClick={() => { setSelectedId(w.id); test.mutate(w.id); }}><FlaskConical size={14} /></button>
                      <button type="button" className="btn subtle icon danger" title="Supprimer" onClick={() => remove.mutate(w.id)}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {selected ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, borderTop: "1px solid var(--line)" }}>
            <div className="view-head" style={{ height: 36 }}>
              <strong style={{ fontSize: 12 }}>Livraisons — webhook #{selected.id} ({selected.kind})</strong>
              <span className="spacer" />
              <button type="button" className="btn subtle icon" title="Rafraîchir" onClick={() => void deliveries.refetch()}>⟳</button>
            </div>
            {deliveries.isPending ? <Loading /> :
             dels.length === 0 ? <EmptyState title="Aucune livraison" hint="Lancez un test avec l'erlenmeyer ci-dessus." /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th style={{ width: 60 }}>ID</th>
                      <th style={{ width: 160 }}>Événement</th>
                      <th style={{ width: 90 }}>Statut</th>
                      <th style={{ width: 70 }}>Tentatives</th>
                      <th style={{ width: 110 }}>Créée</th>
                      <th style={{ width: 110 }}>Prochaine</th>
                      <th>Dernière erreur</th>
                      <th style={{ width: 60 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {dels.map((d) => (
                      <tr key={d.id}>
                        <td className="mono">#{d.id}</td>
                        <td className="mono">{d.event}</td>
                        <td><Chip cls={STATUS_CHIP[d.status] ?? null}>{d.status}</Chip></td>
                        <td className="num">{d.attempts}</td>
                        <td className="muted" title={dt(d.createdAt)}>{timeAgo(d.createdAt)}</td>
                        <td className="muted">{d.nextAttemptAt ? timeAgo(d.nextAttemptAt).replace("il y a", "dans") : "—"}</td>
                        <td className="muted" style={{ maxWidth: 300 }}>{d.lastError ?? "—"}</td>
                        <td style={{ textAlign: "right" }}>
                          {d.status === "dead" || d.status === "failed" ? (
                            <button type="button" className="btn subtle icon" title="Rejouer" onClick={() => replay.mutate(d.id)}><RotateCcw size={14} /></button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}
