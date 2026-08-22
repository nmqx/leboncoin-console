import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Pause, Trash2, Plus, X, Pencil, RefreshCw, Eye } from "lucide-react";
import type { SearchSpec, Watch } from "@lbc/contracts";

/** GET /watches renvoie le nombre de résultats liés par veille. */
type WatchWithCount = Watch & { listingCount?: number };
import { LBC_CATEGORIES, rangeAttributesForCategory } from "@lbc/contracts";
import { api } from "../../api";
import { timeAgo, dt } from "../../format";
import { Chip, EmptyState, ErrorState, Loading, Toggle } from "../../components/ui";

// ---------------------------------------------------------------------------
// Formulaire veille : requête + filtres + cadence + seuil bonne affaire
// ---------------------------------------------------------------------------

interface WatchForm {
  name: string;
  query: string;
  priceMin: string;
  priceMax: string;
  ownerType: "" | "private" | "pro";
  department: string;
  shippable: boolean;
  category: string;
  urgent: boolean;
  adType: "" | "offer" | "demand";
  attrRanges: Record<string, { min: string; max: string }>;
  maxItems: number;
  llmFilter: boolean;
  cadenceMinutes: number;
  dealThreshold: string; // % sous la médiane, vide = pas de seuil
}

const EMPTY_FORM: WatchForm = {
  name: "",
  query: "",
  priceMin: "",
  priceMax: "",
  ownerType: "",
  department: "",
  shippable: false,
  category: "",
  urgent: false,
  adType: "",
  attrRanges: {},
  maxItems: 10,
  llmFilter: true,
  cadenceMinutes: 10,
  dealThreshold: "",
};

function specToForm(w: Watch): WatchForm {
  const s = w.spec;
  const attrs = (s.attributes ?? {}) as Record<string, { min?: number; max?: number }>;
  const attrRanges: WatchForm["attrRanges"] = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v && typeof v === "object") attrRanges[k] = { min: v.min !== undefined ? String(v.min) : "", max: v.max !== undefined ? String(v.max) : "" };
  }
  return {
    name: w.name,
    query: s.query === "toutes annonces" ? "" : s.query,
    priceMin: s.priceCents?.min !== undefined ? String(s.priceCents.min / 100) : "",
    priceMax: s.priceCents?.max !== undefined ? String(s.priceCents.max / 100) : "",
    ownerType: s.ownerTypes?.[0] ?? "",
    department: s.locations?.departments?.[0] ?? "",
    shippable: s.shippable === true,
    category: s.categoryIds?.[0] ?? "",
    urgent: s.urgent === true,
    adType: s.adTypes?.[0] ?? "",
    attrRanges,
    maxItems: s.maxItems ?? 10,
    llmFilter: s.llmFilter === true,
    cadenceMinutes: w.cadenceMinutes,
    dealThreshold: s.dealThreshold !== undefined ? String(Math.round(s.dealThreshold * 100)) : "",
  };
}

function formToSpec(f: WatchForm): SearchSpec {
  const spec: SearchSpec = { query: f.query.trim() || "toutes annonces", maxItems: 200, filterJunk: true, llmFilter: f.llmFilter };
  if (f.query.trim()) spec.query = f.query.trim();
  if (f.priceMin) spec.priceCents = { ...(spec.priceCents ?? {}), min: Math.round(Number(f.priceMin) * 100) };
  if (f.priceMax) spec.priceCents = { ...(spec.priceCents ?? {}), max: Math.round(Number(f.priceMax) * 100) };
  if (f.ownerType) spec.ownerTypes = [f.ownerType];
  if (f.department) spec.locations = { departments: [f.department.padStart(2, "0")] };
  if (f.shippable) spec.shippable = true;
  if (f.urgent) spec.urgent = true;
  if (f.adType) spec.adTypes = [f.adType];
  if (f.category) spec.categoryIds = [f.category];
  spec.maxItems = Math.max(1, Math.min(1000, f.maxItems || 10));
  const attrs: Record<string, unknown> = {};
  for (const [key, r] of Object.entries(f.attrRanges)) {
    const min = r.min !== "" ? Number(r.min) : undefined;
    const max = r.max !== "" ? Number(r.max) : undefined;
    if (min !== undefined || max !== undefined) attrs[key] = { min, max };
  }
  if (Object.keys(attrs).length > 0) spec.attributes = attrs;
  const pct = Number(f.dealThreshold);
  if (f.dealThreshold !== "" && Number.isFinite(pct) && pct > 0) {
    spec.dealThreshold = Math.min(0.95, pct / 100);
  }
  return spec;
}

function WatchFields({ form, set }: { form: WatchForm; set: (patch: Partial<WatchForm>) => void }) {
  const rangeAttrs = useMemo(() => rangeAttributesForCategory(form.category || undefined), [form.category]);
  return (
    <>
      <label className="field">Nom
        <input type="text" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Vélos route pas chers" />
      </label>
      <label className="field" style={{ minWidth: 180 }}>Requête (obligatoire)
        <input type="text" value={form.query} onChange={(e) => set({ query: e.target.value })} placeholder="vélo route" />
      </label>
      <label className="field">Catégorie
        <select value={form.category} onChange={(e) => set({ category: e.target.value, attrRanges: {} })}>
          <option value="">Toutes</option>
          {Object.entries(LBC_CATEGORIES).map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
      </label>
      <label className="field">€ min
        <input className="price" type="number" min={0} value={form.priceMin} onChange={(e) => set({ priceMin: e.target.value })} />
      </label>
      <label className="field">€ max
        <input className="price" type="number" min={0} value={form.priceMax} onChange={(e) => set({ priceMax: e.target.value })} />
      </label>
      <label className="field">Vendeur
        <select value={form.ownerType} onChange={(e) => set({ ownerType: e.target.value as WatchForm["ownerType"] })}>
          <option value="">Tous</option>
          <option value="private">Particuliers</option>
          <option value="pro">Pros</option>
        </select>
      </label>
      <label className="field">Annonce
        <select value={form.adType} onChange={(e) => set({ adType: e.target.value as WatchForm["adType"] })}>
          <option value="">Offres & demandes</option>
          <option value="offer">Offres</option>
          <option value="demand">Demandes</option>
        </select>
      </label>
      <label className="field">Dépt
        <input type="text" style={{ width: 60 }} value={form.department} onChange={(e) => set({ department: e.target.value })} placeholder="69" />
      </label>
      {rangeAttrs.map((a) => (
        <label className="field" key={a.key}>{a.label}
          <span style={{ display: "inline-flex", gap: 4 }}>
            <input className="price" type="number" placeholder="min" aria-label={`${a.label} min`}
              value={form.attrRanges[a.key]?.min ?? ""}
              onChange={(e) => set({ attrRanges: { ...form.attrRanges, [a.key]: { min: e.target.value, max: form.attrRanges[a.key]?.max ?? "" } } })} />
            <input className="price" type="number" placeholder="max" aria-label={`${a.label} max`}
              value={form.attrRanges[a.key]?.max ?? ""}
              onChange={(e) => set({ attrRanges: { ...form.attrRanges, [a.key]: { min: form.attrRanges[a.key]?.min ?? "", max: e.target.value } } })} />
          </span>
        </label>
      ))}
      <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 16 }}>
        <input type="checkbox" checked={form.shippable} onChange={(e) => set({ shippable: e.target.checked })} style={{ accentColor: "var(--accent)" }} />
        Livrable
      </label>
      <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 16 }}>
        <input type="checkbox" checked={form.urgent} onChange={(e) => set({ urgent: e.target.checked })} style={{ accentColor: "var(--accent)" }} />
        Urgent
      </label>
      <label className="field" title="Nombre maximum d'annonces récupérées par run — défaut 10 (les plus récentes)">
        Nb max
        <input type="number" min={1} max={1000} style={{ width: 64 }} value={form.maxItems}
          onChange={(e) => set({ maxItems: Math.max(1, Number(e.target.value) || 10) })} />
      </label>
      <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 16 }}
        title="Exclut les faux positifs sémantiques via un appel LLM groupé par run (ex. un jeu « Just Dance - Nintendo Switch » quand tu cherches la console). Clé LLM requise dans Système.">
        <input type="checkbox" checked={form.llmFilter} onChange={(e) => set({ llmFilter: e.target.checked })} style={{ accentColor: "var(--accent)" }} />
        Filtre LLM
      </label>
      <label className="field">Cadence (min)
        <input type="number" min={1} max={1440} style={{ width: 70 }} value={form.cadenceMinutes}
          onChange={(e) => set({ cadenceMinutes: Math.max(1, Number(e.target.value) || 10) })} />
      </label>
      <label className="field" title="Ne garde que les annonces au moins X % sous la médiane des résultats — vide = tout garder">
        Top % affaire
        <input type="number" min={1} max={95} style={{ width: 70 }} value={form.dealThreshold}
          onChange={(e) => set({ dealThreshold: e.target.value })} placeholder="30" />
      </label>
    </>
  );
}

function WatchEditor({
  form, set, title, saveLabel, busy, invalid, onSave, onCancel,
}: {
  form: WatchForm;
  set: (patch: Partial<WatchForm>) => void;
  title: string;
  saveLabel: string;
  busy?: boolean;
  invalid?: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="panel watch-editor" style={{ padding: 14, margin: "0 0 12px 0" }}>
      <div className="panel-title" style={{ padding: 0, marginBottom: 12 }}>{title}</div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
        <WatchFields form={form} set={set} />
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
        <button type="button" className="btn primary" disabled={busy || invalid} onClick={onSave}>
          {busy ? "…" : saveLabel}
        </button>
        <button type="button" className="btn" onClick={onCancel}>Annuler</button>
        {invalid ? <span className="muted" style={{ fontSize: 11 }}>une requête est obligatoire</span> : null}
      </div>
    </section>
  );
}

export default function WatchesView() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["watches"], queryFn: api.watches });
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<WatchForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<WatchForm>(EMPTY_FORM);
  const [runningId, setRunningId] = useState<number | null>(null);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["watches"] });
    void qc.invalidateQueries({ queryKey: ["listings"] });
  };

  const run = useMutation({
    mutationFn: (id: number) => {
      setRunningId(id);
      return api.runWatch(id);
    },
    onSettled: () => setRunningId(null),
    onSuccess: invalidate,
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => api.updateWatch(id, { enabled }),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: api.deleteWatch, onSuccess: invalidate });
  const create = useMutation({
    mutationFn: () =>
      api.createWatch(createForm.name.trim() || "Veille", formToSpec(createForm), createForm.cadenceMinutes),
    onSuccess: () => {
      invalidate();
      setCreateOpen(false);
      setCreateForm(EMPTY_FORM);
    },
  });
  const saveEdit = useMutation({
    mutationFn: (id: number) =>
      api.updateWatch(id, {
        name: editForm.name.trim() || "Veille",
        spec: formToSpec(editForm),
        cadenceMinutes: editForm.cadenceMinutes,
      }),
    onSuccess: () => {
      invalidate();
      setEditingId(null);
    },
  });

  function specSummary(w: Watch): string {
    const s = w.spec;
    const parts: string[] = [s.query];
    if (s.categoryIds?.[0]) parts.push(LBC_CATEGORIES[s.categoryIds[0]] ?? `cat ${s.categoryIds[0]}`);
    if (s.priceCents?.min) parts.push(`≥ ${s.priceCents.min / 100} €`);
    if (s.priceCents?.max) parts.push(`≤ ${s.priceCents.max / 100} €`);
    if (s.ownerTypes?.length) parts.push(s.ownerTypes.join("/"));
    if (s.adTypes?.length === 1 && s.adTypes[0] === "demand") parts.push("demandes");
    if (s.locations?.departments?.length) parts.push(s.locations.departments.join(","));
    if (s.shippable) parts.push("livrable");
    if (s.urgent) parts.push("urgent");
    for (const [k, v] of Object.entries(s.attributes ?? {})) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const r = v as { min?: number; max?: number };
        parts.push(`${k} ${r.min ?? "…"}-${r.max ?? "…"}`);
      }
    }
    if (s.dealThreshold !== undefined) parts.push(`top ${Math.round(s.dealThreshold * 100)} %`);
    if (s.llmFilter) parts.push("filtre LLM");
    parts.push(`max ${s.maxItems ?? 10}`);
    return parts.join(" · ");
  }

  return (
    <>
      <div className="view-head">
        <h1>Veilles</h1>
        <span className="muted" style={{ fontSize: 11 }}>cadence par veille + jitter — un échec passe en quarantaine, jamais en liste vide</span>
        <span className="spacer" />
        <button type="button" className="btn primary" onClick={() => { setCreateOpen((v) => !v); setEditingId(null); }}>
          <Plus size={14} />Nouvelle veille
        </button>
      </div>

      <div style={{ padding: "0 16px", overflowY: "auto", flex: 1, minHeight: 0 }}>
        {createOpen ? (
          <WatchEditor
            form={createForm}
            set={(p) => setCreateForm((f) => ({ ...f, ...p }))}
            title="Nouvelle veille"
            saveLabel="Créer la veille"
            busy={create.isPending}
            invalid={!createForm.query.trim()}
            onSave={() => create.mutate()}
            onCancel={() => setCreateOpen(false)}
          />
        ) : null}

        {editingId !== null ? (
          <WatchEditor
            form={editForm}
            set={(p) => setEditForm((f) => ({ ...f, ...p }))}
            title={`Modifier — ${editForm.name || "veille"}`}
            saveLabel="Enregistrer"
            busy={saveEdit.isPending}
            invalid={!editForm.query.trim()}
            onSave={() => saveEdit.mutate(editingId)}
            onCancel={() => setEditingId(null)}
          />
        ) : null}

        {list.isPending ? <Loading /> :
         list.isError ? <ErrorState error={{ code: "Erreur", message: (list.error as Error).message }} onRetry={() => void list.refetch()} /> :
         (list.data?.watches.length ?? 0) === 0 && !createOpen ? (
           <EmptyState title="Aucune veille" hint={<>Créez-en une : requête obligatoire, puis filtres, cadence et seuil de bonne affaire au choix.</>} />
         ) : (
          <div className="table-wrap" style={{ flex: "none", maxHeight: "calc(100vh - 260px)" }}>
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: 34 }}></th>
                  <th>Nom</th>
                  <th>Spécification</th>
                  <th style={{ width: 70 }}>Cadence</th>
                  <th style={{ width: 110 }}>Dernier run</th>
                  <th style={{ width: 110 }}>Statut</th>
                  <th style={{ width: 150 }}>Résultats</th>
                  <th style={{ width: 210 }}></th>
                </tr>
              </thead>
              <tbody>
                {list.data!.watches.map((w) => (
                  <tr key={w.id}>
                    <td><Toggle on={w.enabled} label={`Activer ${w.name}`} onChange={(enabled) => toggle.mutate({ id: w.id, enabled })} /></td>
                    <td title={w.name} style={{ maxWidth: 200 }}><strong>{w.name}</strong></td>
                    <td className="muted" title={specSummary(w)} style={{ maxWidth: 340 }}>{specSummary(w)}</td>
                    <td className="num">{w.cadenceMinutes} min</td>
                    <td title={dt(w.lastRunAt)}>{timeAgo(w.lastRunAt)}</td>
                    <td>
                      {w.lastStatus === "completed" ? <Chip cls="accent">complétée</Chip> :
                       w.lastStatus === "quarantined" ? <Chip cls="coral">quarantaine</Chip> :
                       w.lastStatus ? <Chip cls="amber">{w.lastStatus}</Chip> :
                       <span className="muted">jamais lancée</span>}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn subtle"
                        title="Voir les résultats de cette veille dans Recherche"
                        onClick={() => {
                          window.sessionStorage.setItem("lbc.watchFilter", String(w.id));
                          window.location.hash = "#/search";
                        }}
                      >
                        <Eye size={13} />résultats{typeof (w as WatchWithCount).listingCount === "number" ? ` · ${(w as WatchWithCount).listingCount}` : ""}
                      </button>
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        className="btn primary icon"
                        style={{ minWidth: 30 }}
                        title="Lancer maintenant"
                        disabled={runningId === w.id}
                        onClick={() => run.mutate(w.id)}
                      >
                        {runningId === w.id
                          ? <RefreshCw size={14} className="spin" />
                          : <Play size={14} />}
                      </button>
                      <button type="button" className="btn" onClick={() => {
                        setCreateOpen(false);
                        setEditingId(editingId === w.id ? null : w.id);
                        setEditForm(specToForm(w));
                      }}>
                        <Pencil size={13} />modifier
                      </button>
                      <button type="button" className="btn subtle icon" title={w.enabled ? "Désactiver" : "Activer"} onClick={() => toggle.mutate({ id: w.id, enabled: !w.enabled })}>
                        {w.enabled ? <Pause size={14} /> : <Play size={14} />}
                      </button>
                      <button type="button" className="btn subtle icon danger" title="Supprimer" onClick={() => remove.mutate(w.id)}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {run.data ? (
          <div style={{ padding: "8px 0" }}>
            <Chip cls={run.data.status === "completed" ? "accent" : run.data.status === "quarantined" ? "coral" : "amber"}>
              Dernier job : {run.data.status} · {run.data.itemsFound ?? "?"} trouvées · {run.data.itemsNew ?? "?"} nouvelles
              {run.data.error ? ` · ${run.data.error.code} : ${run.data.error.message}` : ""}
            </Chip>
          </div>
        ) : null}
      </div>
    </>
  );
}
