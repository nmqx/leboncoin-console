import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Bell, FileJson, Sheet, Plus, X, GitCompare } from "lucide-react";
import type { Listing, PricePoint } from "@lbc/contracts";
import { LBC_CATEGORIES, rangeAttributesForCategory } from "@lbc/contracts";
import { api, type ListingFilters } from "../../api";
import { price, dt, timeAgo, dealLabel } from "../../format";
import { Chip, ScoreBar, Sparkline, EmptyState, ErrorState, Loading } from "../../components/ui";
import VirtualTable, { type Column } from "../../components/VirtualTable";
import { useHotkey } from "../../hotkeys";
import ListingDetail from "./ListingDetail";

export interface ActiveFilters {
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
  sort: "publishedAt" | "price" | "relevance" | "distance";
  dir: "asc" | "desc";
}

const DEFAULT_FILTERS: ActiveFilters = {
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
  sort: "publishedAt",
  dir: "desc",
};

function MiniSegmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div className="segmented" style={{ height: 28 }}>
      {options.map((o) => (
        <button key={o.value} type="button" className={`segmented-item${value === o.value ? " active" : ""}`} style={{ padding: "0 8px", fontSize: 11 }} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function toSpec(f: ActiveFilters): Record<string, unknown> {
  const spec: Record<string, unknown> = { query: f.query.trim() || "toutes annonces", maxItems: 200 };
  if (f.priceMin) spec.priceCents = { ...(spec.priceCents as object), min: Math.round(Number(f.priceMin) * 100) };
  if (f.priceMax) spec.priceCents = { ...(spec.priceCents as object), max: Math.round(Number(f.priceMax) * 100) };
  if (f.ownerType) spec.ownerTypes = [f.ownerType];
  if (f.department) spec.locations = { departments: [f.department.padStart(2, "0")] };
  if (f.shippable) spec.shippable = true;
  if (f.urgent) spec.urgent = true;
  if (f.adType) spec.adTypes = [f.adType];
  if (f.category) spec.categoryIds = [f.category];
  spec.maxItems = Math.max(1, Math.min(1000, f.maxItems || 10));
  if (f.llmFilter === false) spec.llmFilter = false; // défaut contrat: true — décoché doit survivre au parse
  const attrs: Record<string, unknown> = {};
  for (const [key, r] of Object.entries(f.attrRanges)) {
    const min = r.min !== "" ? Number(r.min) : undefined;
    const max = r.max !== "" ? Number(r.max) : undefined;
    if (min !== undefined || max !== undefined) attrs[key] = { min, max };
  }
  if (Object.keys(attrs).length > 0) spec.attributes = attrs;
  return spec;
}

export default function SearchView() {
  const qc = useQueryClient();
  const [filters, setFilters] = useState<ActiveFilters>(DEFAULT_FILTERS);
  // si la vue Veilles a déposé un filtre, il s'applique dès le premier rendu
  const [applied, setApplied] = useState<ListingFilters>(() => {
    const v = window.sessionStorage.getItem("lbc.watchFilter");
    const n = v ? Number(v) : NaN;
    const f: ListingFilters = { limit: 300, sort: "publishedAt", dir: "desc" };
    if (Number.isInteger(n) && n > 0) f.watchId = n;
    return f;
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [watchBar, setWatchBar] = useState(false);
  const queryRef = useRef<HTMLInputElement>(null);

  // Filtre par veille : main tendue par la vue Veilles (sessionStorage),
  // ou choix direct dans la barre — filtre la base, ne relance PAS de run.
  const [watchFilter, setWatchFilter] = useState<number | "">(() => {
    const v = window.sessionStorage.getItem("lbc.watchFilter");
    window.sessionStorage.removeItem("lbc.watchFilter");
    const n = v ? Number(v) : NaN;
    return Number.isInteger(n) && n > 0 ? n : "";
  });
  const watchesQuery = useQuery({ queryKey: ["watches"], queryFn: api.watches });

  const setWatch = (id: number | "") => {
    setWatchFilter(id);
    setApplied((prev) => {
      const f: ListingFilters = { ...prev };
      if (id) f.watchId = id;
      else delete f.watchId;
      return f;
    });
  };

  useHotkey({ key: "/", description: "Focus recherche", handler: () => queryRef.current?.focus() });

  const list = useQuery({
    queryKey: ["listings", applied],
    queryFn: () => api.listings(applied),
    placeholderData: (prev) => prev,
  });

  const rows = useMemo(() => list.data?.items ?? [], [list.data]);

  // navigation clavier j/k dans la liste
  const [cursor, setCursor] = useState(0);
  useHotkey({
    key: "j",
    description: "Ligne suivante",
    handler: () => setCursor((c) => Math.min(rows.length - 1, c + 1)),
  });
  useHotkey({
    key: "k",
    description: "Ligne précédente",
    handler: () => setCursor((c) => Math.max(0, c - 1)),
  });

  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const compareRows = rows.filter((r) => compareIds.includes(r.id));

  const runSearch = useMutation({
    mutationFn: (spec: Record<string, unknown>) => api.searchJob(spec),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["listings"] }),
  });

  const apply = (next: ActiveFilters) => {
    setFilters(next);
    const f: ListingFilters = { limit: 300, sort: next.sort, dir: next.dir };
    if (next.query.trim()) f.query = next.query.trim();
    if (next.priceMin) f.priceMin = Math.round(Number(next.priceMin) * 100);
    if (next.priceMax) f.priceMax = Math.round(Number(next.priceMax) * 100);
    if (next.ownerType) f.ownerType = next.ownerType;
    if (next.department) f.department = next.department;
    if (next.shippable) f.shippable = true;
    setApplied(f);
    // Un job upstream ne part QUE sur requête réelle : une recherche vide
    // filtrerait sinon le flux générique de la page d'accueil Leboncoin
    // (colocations, rameurs, toute la France) et polluerait la base.
    if (next.query.trim()) {
      runSearch.mutate(toSpec(next));
    }
  };

  const set = (patch: Partial<ActiveFilters>) => apply({ ...filters, ...patch });

  const rangeAttrs = useMemo(
    () => rangeAttributesForCategory(filters.category || undefined),
    [filters.category]
  );

  const toggleSort = (key: string) => {
    if (filters.sort === key) set({ dir: filters.dir === "asc" ? "desc" : "asc" });
    else set({ sort: key as ActiveFilters["sort"], dir: key === "price" ? "asc" : "desc" });
  };

  const columns: Array<Column<Listing>> = [
    {
      key: "compare", header: "", width: "28px",
      render: (l) => (
        <input
          type="checkbox"
          aria-label={`Comparer ${l.title}`}
          checked={compareIds.includes(l.id)}
          onClick={(e) => e.stopPropagation()}
          onChange={() =>
            setCompareIds((ids) =>
              ids.includes(l.id)
                ? ids.filter((i) => i !== l.id)
                : ids.length >= 4
                  ? ids
                  : [...ids, l.id]
            )
          }
        />
      ),
    },
    {
      key: "thumb", header: "", width: "54px",
      render: (l) =>
        l.images[0] ? (
          <img className="thumb" src={l.images[0]} alt="" loading="lazy" referrerPolicy="no-referrer" />
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: "score", header: "Pertinence", width: "92px", sortKey: "relevance",
      render: (l) => <ScoreBar value={l.score} />,
    },
    {
      key: "title", header: "Titre", width: "minmax(260px, 3fr)",
      render: (l) => (
        <span title={l.body ?? l.title} style={{ overflow: "hidden", textOverflow: "ellipsis", display: "inline-flex", alignItems: "center", gap: 6 }}>
          {l.title}
          {(l.attributes as Record<string, unknown>)?._achatEnCours ? <Chip cls="coral">achat en cours</Chip> : null}
        </span>
      ),
    },
    { key: "city", header: "Ville", width: "110px", render: (l) => <span className="muted">{l.location?.city ?? "—"}</span> },
    { key: "category", header: "Catégorie", width: "90px", render: (l) => <span className="muted">{l.category ?? "—"}</span> },
    {
      key: "price", header: "Prix", width: "90px", align: "right", sortKey: "price",
      render: (l) => <strong>{price(l.priceCents)}</strong>,
    },
    {
      key: "deal", header: "Affaire", width: "84px",
      render: (l) => {
        const d = dealLabel(l.dealScore);
        return d.cls ? <Chip cls={d.cls}>{d.label}</Chip> : <span className="muted">{d.label}</span>;
      },
    },
    {
      key: "owner", header: "Vendeur", width: "70px",
      render: (l) => (l.owner?.type === "pro" ? <Chip cls="info">pro</Chip> : <span className="muted">part.</span>),
    },
    {
      key: "published", header: "Publié", width: "90px", sortKey: "publishedAt",
      render: (l) => <span className="muted" title={dt(l.publishedAt)}>{timeAgo(l.publishedAt)}</span>,
    },
    {
      key: "source", header: "Source", width: "80px",
      render: (l) => <span className="mono muted">{l.source.replace("authorized-", "")}</span>,
    },
  ];

  const exportData = (format: "csv" | "json") => {
    const data = rows.map(({ id, title, priceCents, category, location, owner, publishedAt, url, score }) => ({
      id, titre: title, prix: priceCents ? priceCents / 100 : "", categorie: category ?? "",
      ville: location?.city ?? "", cp: location?.postalCode ?? "", vendeur: owner?.type ?? "",
      publie: publishedAt ?? "", url, score,
    }));
    let blob: Blob;
    if (format === "json") {
      blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    } else {
      const header = Object.keys(data[0] ?? { id: "" }).join(";");
      const lines = data.map((d) => Object.values(d).map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";"));
      blob = new Blob(["\uFEFF" + [header, ...lines].join("\r\n")], { type: "text/csv" });
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `annonces-${new Date().toISOString().slice(0, 10)}.${format}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <div className="view-head">
        <h1>Recherche</h1>
        {runSearch.isPending ? <Chip cls="accent">job en cours…</Chip> : null}
        {runSearch.data ? (
          <Chip cls={runSearch.data.status === "completed" ? "accent" : "amber"}>
            {runSearch.data.status} · {runSearch.data.itemsFound ?? "?"} trouvées · {runSearch.data.itemsNew ?? "?"} nouvelles
          </Chip>
        ) : null}
        <span className="spacer" />
        <button type="button" className="btn subtle icon" title="Export CSV" onClick={() => exportData("csv")}><Sheet size={15} /></button>
        <button type="button" className="btn subtle icon" title="Export JSON" onClick={() => exportData("json")}><FileJson size={15} /></button>
        <button type="button" className="btn" onClick={() => setWatchBar((v) => !v)}><Plus size={14} />Créer une veille</button>
      </div>

      {watchBar ? (
        <WatchBar filters={filters} onDone={() => setWatchBar(false)} />
      ) : null}

      <div className="filters">
        <div className="filters-row">
          <input
            ref={queryRef}
            type="text"
            data-autofocus
            className="search-main"
            placeholder="Rechercher…  (/ puis Entrée)"
            value={filters.query}
            onChange={(e) => setFilters({ ...filters, query: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && apply(filters)}
          />
          <input className="price" type="number" min={0} placeholder="€ min" value={filters.priceMin} onChange={(e) => set({ priceMin: e.target.value })} aria-label="Prix minimum" />
          <input className="price" type="number" min={0} placeholder="€ max" value={filters.priceMax} onChange={(e) => set({ priceMax: e.target.value })} aria-label="Prix maximum" />
          <select value={filters.category} onChange={(e) => set({ category: e.target.value, attrRanges: {} })} aria-label="Catégorie" title="Catégorie Leboncoin" style={{ height: 34 }}>
            <option value="">Catégorie</option>
            {Object.entries(LBC_CATEGORIES).map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
          <input type="text" placeholder="Dépt" style={{ width: 64, height: 34 }} value={filters.department} onChange={(e) => set({ department: e.target.value })} aria-label="Département" />
          <select
            value={watchFilter}
            onChange={(e) => setWatch(e.target.value ? Number(e.target.value) : "")}
            aria-label="Source"
            title="Filtrer par veille — Leboncoin direct par défaut"
            style={{ height: 34, minWidth: 140 }}
          >
            <option value="">Leboncoin direct</option>
            {(watchesQuery.data?.watches ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <select value={filters.sort} onChange={(e) => set({ sort: e.target.value as ActiveFilters["sort"] })} aria-label="Tri" style={{ height: 34 }}>
            <option value="publishedAt">Plus récents</option>
            <option value="price">Prix</option>
            <option value="relevance">Pertinence</option>
          </select>
          <button
            type="button"
            className="btn subtle icon"
            title={filters.dir === "asc" ? "Croissant" : "Décroissant"}
            onClick={() => set({ dir: filters.dir === "asc" ? "desc" : "asc" })}
            style={{ height: 28 }}
          >
            {filters.dir === "asc" ? "↑" : "↓"}
          </button>
          <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>{rows.length} / {list.data?.total ?? 0}</span>
        </div>
        <div className="filters-row">
          <MiniSegmented value={filters.ownerType} onChange={(v) => set({ ownerType: v as ActiveFilters["ownerType"] })} options={[{ value: "", label: "Tous" }, { value: "private", label: "Part." }, { value: "pro", label: "Pro" }]} />
          <MiniSegmented value={filters.adType} onChange={(v) => set({ adType: v as ActiveFilters["adType"] })} options={[{ value: "", label: "Tous types" }, { value: "offer", label: "Offres" }, { value: "demand", label: "Demandes" }]} />
          {rangeAttrs.map((a) => (
            <span key={a.key} style={{ display: "inline-flex", gap: 4, alignItems: "center" }} title={a.label}>
              <input
                type="number"
                className="price"
                placeholder={`${a.label} min`}
                aria-label={`${a.label} min`}
                value={filters.attrRanges[a.key]?.min ?? ""}
                onChange={(e) => set({ attrRanges: { ...filters.attrRanges, [a.key]: { min: e.target.value, max: filters.attrRanges[a.key]?.max ?? "" } } })}
                style={{ height: 28 }}
              />
              <input
                type="number"
                className="price"
                placeholder="max"
                aria-label={`${a.label} max`}
                value={filters.attrRanges[a.key]?.max ?? ""}
                onChange={(e) => set({ attrRanges: { ...filters.attrRanges, [a.key]: { min: filters.attrRanges[a.key]?.min ?? "", max: e.target.value } } })}
                style={{ height: 28 }}
              />
            </span>
          ))}
          <label className="field-compact"><input type="checkbox" checked={filters.urgent} onChange={(e) => set({ urgent: e.target.checked })} />Urgent</label>
          <label className="field-compact"><input type="checkbox" checked={filters.shippable} onChange={(e) => set({ shippable: e.target.checked })} />Livrable</label>
          <label className="field-compact" title="Filtre sémantique LLM — clé requise"><input type="checkbox" checked={filters.llmFilter} onChange={(e) => set({ llmFilter: e.target.checked })} />LLM</label>
          <span className="sep" />
          <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6, fontSize: 11 }}>Nb max
            <input type="number" min={1} max={1000} style={{ width: 56, height: 28 }} value={filters.maxItems}
              onChange={(e) => set({ maxItems: Math.max(1, Number(e.target.value) || 10) })} />
          </label>
        </div>
      </div>

      {compareIds.length >= 2 ? (
        <CompareStrip rows={compareRows} onClear={() => setCompareIds([])} onRemove={(id) => setCompareIds((ids) => ids.filter((i) => i !== id))} />
      ) : null}

      <div className="view-body">
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, position: "relative" }}>
          {list.isPending ? (
            <>
              <div className="loading-bar" />
              <Loading label="Chargement des annonces…" />
            </>
          ) : list.isError ? (
            <ErrorState
              error={{ code: "Erreur API", message: (list.error as Error).message }}
              onRetry={() => void list.refetch()}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              title="Aucune annonce pour ces filtres"
              hint={<>Lancez une requête — un résultat vide n'est jamais silencieux : le job affiche trouvé/nouvelles ci-dessus.</>}
            />
          ) : (
            <VirtualTable
              rows={rows}
              columns={columns}
              rowKey={(l) => l.id}
              activeKey={rows[cursor]?.id === selectedId ? selectedId : (selectedId ?? rows[cursor]?.id ?? null)}
              onRowClick={(l) => {
                setSelectedId(l.id);
                setCursor(rows.indexOf(l));
              }}
              onRowKeyDown={(e, i) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setSelectedId(rows[i]!.id);
                }
                if (e.key === "ArrowDown") { e.preventDefault(); setCursor(Math.min(rows.length - 1, i + 1)); }
                if (e.key === "ArrowUp") { e.preventDefault(); setCursor(Math.max(0, i - 1)); }
              }}
              sort={{ key: filters.sort, dir: filters.dir }}
              onSort={toggleSort}
              focusIndex={cursor}
            />
          )}
        </div>
        {selected ? (
          <ListingDetail
            id={selected.id}
            onClose={() => setSelectedId(null)}
            onCreateWatch={(maxPrice) => {
              void api.createWatch(`Veille prix — ${selected.title.slice(0, 40)}`, {
                query: filters.query || selected.title.split(" ").slice(0, 3).join(" "),
                priceCents: { max: Math.round(maxPrice * 100) },
                maxItems: 100,
              });
              qc.invalidateQueries({ queryKey: ["watches"] });
            }}
          />
        ) : null}
      </div>
    </>
  );
}

function WatchBar({ filters, onDone }: { filters: ActiveFilters; onDone: () => void }) {
  const [name, setName] = useState(`Veille — ${filters.query || "toutes"}`);
  const [cadence, setCadence] = useState(10);
  const [threshold, setThreshold] = useState("");
  const create = useMutation({
    mutationFn: () => {
      const spec = toSpec(filters);
      const pct = Number(threshold);
      if (threshold !== "" && Number.isFinite(pct) && pct > 0) {
        spec.dealThreshold = Math.min(0.95, pct / 100);
      }
      return api.createWatch(name.trim() || "Veille", spec, cadence);
    },
    onSuccess: onDone,
  });
  return (
    <div className="filters" style={{ background: "var(--bg-2)", alignItems: "flex-end" }}>
      <label className="field" style={{ minWidth: 220 }}>Nom
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} aria-label="Nom de la veille" />
      </label>
      <span className="muted" style={{ fontSize: 11, paddingBottom: 8 }}>
        Spéc : {filters.query || "requête requise"}{filters.priceMax ? ` ≤ ${filters.priceMax} €` : ""}{filters.department ? ` · ${filters.department}` : ""}
      </span>
      <label className="field">Cadence (min)
        <input type="number" min={1} max={1440} style={{ width: 70 }} value={cadence}
          onChange={(e) => setCadence(Math.max(1, Number(e.target.value) || 10))} />
      </label>
      <label className="field" title="Ne garde que les annonces au moins X % sous la médiane — vide = tout">
        Top % affaire
        <input type="number" min={1} max={95} style={{ width: 70 }} value={threshold}
          onChange={(e) => setThreshold(e.target.value)} placeholder="30" />
      </label>
      <span style={{ flex: 1 }} />
      <button type="button" className="btn primary" disabled={create.isPending || !filters.query.trim()} title={filters.query.trim() ? undefined : "Une veille exige une requête"} onClick={() => create.mutate()}>
        {create.isPending ? "Création…" : <><Bell size={13} />Sauvegarder</>}
      </button>
      <button type="button" className="btn subtle icon" onClick={onDone} aria-label="Annuler"><X size={14} /></button>
    </div>
  );
}

function CompareStrip({ rows, onClear, onRemove }: { rows: Listing[]; onClear: () => void; onRemove: (id: string) => void }) {
  return (
    <div className="filters" style={{ background: "var(--bg-2)", gap: 6 }}>
      <GitCompare size={14} style={{ color: "var(--accent)" }} />
      {rows.map((r) => (
        <Chip key={r.id} cls="accent">
          {r.title.slice(0, 28)}… {price(r.priceCents)}
          <button type="button" className="btn subtle icon" style={{ padding: 0 }} onClick={() => onRemove(r.id)} aria-label={`Retirer ${r.title}`}>
            <X size={11} />
          </button>
        </Chip>
      ))}
      <span style={{ flex: 1 }} />
      <button type="button" className="btn subtle" onClick={onClear}>Vider</button>
    </div>
  );
}
