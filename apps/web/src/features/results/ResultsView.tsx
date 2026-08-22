import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink, Eye, Play, RefreshCw } from "lucide-react";
import type { Listing } from "@lbc/contracts";
import { api, type ListingFilters } from "../../api";
import { price, dt, timeAgo, dealLabel } from "../../format";
import { Chip, ScoreBar, EmptyState, ErrorState, Loading } from "../../components/ui";
import VirtualTable, { type Column } from "../../components/VirtualTable";

function parseWatchHash(): number | null {
  const m = window.location.hash.match(/^#\/results(?:\?watch=(\d+))?/);
  return m?.[1] ? Number(m[1]) : null;
}

export default function ResultsView() {
  const [watchId, setWatchId] = useState<number | null>(parseWatchHash);

  useEffect(() => {
    const onHash = () => setWatchId(parseWatchHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "publishedAt", dir: "desc" });

  const watches = useQuery({ queryKey: ["watches"], queryFn: api.watches, refetchInterval: 60_000 });

  // veille courante : celle du hash, sinon la première de la liste
  const current = useMemo(() => {
    const list = watches.data?.watches ?? [];
    if (list.length === 0) return null;
    return list.find((w) => w.id === watchId) ?? list[0]!;
  }, [watches.data, watchId]);

  const filters: ListingFilters | null = current
    ? { watchId: current.id, limit: 500, sort: sort.key as ListingFilters["sort"], dir: sort.dir }
    : null;

  const list = useQuery({
    queryKey: ["listings", "results", current?.id ?? 0, sort],
    queryFn: () => api.listings(filters!),
    enabled: filters !== null,
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });

  const rows = useMemo(() => list.data?.items ?? [], [list.data]);

  const run = useMutation({ mutationFn: (id: number) => api.runWatch(id) });

  const select = (id: number) => {
    window.location.hash = `#/results?watch=${id}`;
    setWatchId(id);
  };

  const toggleSort = (key: string) => {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "price" ? "asc" : "desc" }
    );
  };

  const columns: Array<Column<Listing>> = [
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
      key: "title", header: "Titre", width: "minmax(280px, 1fr)",
      render: (l) => (
        <span title={l.body ?? l.title} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {l.title}
          {(l.attributes as Record<string, unknown>)?._achatEnCours ? <Chip cls="coral">achat en cours</Chip> : null}
        </span>
      ),
    },
    { key: "city", header: "Ville", width: "120px", render: (l) => <span className="muted">{l.location?.city ?? "—"}</span> },
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
      key: "score", header: "Pertinence", width: "92px", sortKey: "relevance",
      render: (l) => <ScoreBar value={l.score} />,
    },
    {
      key: "published", header: "Publié", width: "110px", sortKey: "publishedAt",
      render: (l) => <span className="muted" title={dt(l.publishedAt)}>{timeAgo(l.publishedAt)}</span>,
    },
    {
      key: "link", header: "", width: "40px",
      render: (l) => (
        <a
          href={l.url}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(e) => e.stopPropagation()}
          className="row-link"
          aria-label={`Ouvrir ${l.title}`}
        >
          <ExternalLink size={13} />
        </a>
      ),
    },
  ];

  if (watches.isPending) return <Loading label="Chargement des veilles…" />;
  if (watches.isError)
    return <ErrorState error={{ code: "Erreur", message: (watches.error as Error).message }} onRetry={() => void watches.refetch()} />;

  if (!current) {
    return (
      <>
        <div className="view-head"><h1>Résultats</h1></div>
        <EmptyState
          title="Aucune veille à afficher"
          hint={<>Créez une veille dans l'onglet Veilles — ses annonces arriveront ici, rafraîchies à sa cadence.</>}
        />
      </>
    );
  }

  const spec = current.spec;
  const specLine = [
    spec.query,
    spec.priceCents?.max ? `≤ ${spec.priceCents.max / 100} €` : null,
    spec.locations?.departments?.length ? `dépt ${spec.locations.departments.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <div className="view-head">
        <h1>Résultats</h1>
        <Eye size={14} className="muted" />
        <select value={current.id} onChange={(e) => select(Number(e.target.value))} aria-label="Veille">
          {(watches.data?.watches ?? []).map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
        <span className="muted meta-line">{specLine} · toutes les {current.cadenceMinutes} min</span>
        {current.lastStatus === "quarantined" ? <Chip cls="coral">dernier run en échec</Chip> : null}
        <span className="spacer" />
        <span className="muted meta-line" title="rafraîchissement automatique toutes les 30 s">
          {list.isFetching ? <RefreshCw size={11} className="spin" /> : `maj ${timeAgo(new Date(list.dataUpdatedAt || Date.now()).toISOString())}`}
        </span>
        <button
          type="button"
          className="btn"
          disabled={run.isPending}
          onClick={() => current && run.mutate(current.id)}
          title="Relancer cette veille maintenant"
        >
          {run.isPending ? <RefreshCw size={13} className="spin" /> : <Play size={13} />}
          Actualiser
        </button>
      </div>

      <div className="results-bar">
        <span className="muted">{rows.length} annonce{rows.length > 1 ? "s" : ""} liée{rows.length > 1 ? "s" : ""} à cette veille</span>
        {run.data ? (
          <Chip cls={run.data.status === "completed" ? "accent" : "coral"}>
            run manuel : {run.data.status} · {run.data.itemsFound ?? "?"} trouvées · {run.data.itemsNew ?? "?"} nouvelles
          </Chip>
        ) : null}
        <span className="spacer" style={{ flex: 1 }} />
        <span className="muted">dernier run {timeAgo(current.lastRunAt)}</span>
      </div>

      <div className="view-body">
        <div className="table-pane">
          {list.isPending ? (
            <>
              <div className="loading-bar" />
              <Loading label="Chargement des annonces…" />
            </>
          ) : list.isError ? (
            <ErrorState error={{ code: "Erreur API", message: (list.error as Error).message }} onRetry={() => void list.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              title="Pas encore de résultats pour cette veille"
              hint={<>La veille tourne toutes les {current.cadenceMinutes} min — ou lancez-la maintenant avec « Actualiser ».</>}
            />
          ) : (
            <VirtualTable
              rows={rows}
              columns={columns}
              rowKey={(l) => l.id}
              activeKey={null}
              onRowClick={(l) => window.open(l.url, "_blank", "noopener")}
              onRowKeyDown={() => {}}
              sort={{ key: sort.key, dir: sort.dir }}
              onSort={toggleSort}
            />
          )}
        </div>
      </div>
    </>
  );
}
