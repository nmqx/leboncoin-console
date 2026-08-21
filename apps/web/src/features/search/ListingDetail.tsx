import { useQuery } from "@tanstack/react-query";
import { X, ExternalLink, Bell } from "lucide-react";
import { api } from "../../api";
import { price, dt, timeAgo, percent } from "../../format";
import { ScoreBar, Sparkline, Chip, Loading, ErrorState } from "../../components/ui";
import { useHotkey } from "../../hotkeys";

export default function ListingDetail({
  id, onClose, onCreateWatch,
}: {
  id: string;
  onClose: () => void;
  onCreateWatch: (maxPrice: number) => void;
}) {
  const detail = useQuery({
    queryKey: ["listings", "detail", id],
    queryFn: () => api.listing(id),
  });

  useHotkey({ key: "Escape", description: "Fermer le détail", handler: onClose });

  if (detail.isPending) return <aside className="detail"><Loading /></aside>;
  if (detail.isError) {
    return (
      <aside className="detail">
        <ErrorState error={{ code: "Erreur", message: (detail.error as Error).message }} onRetry={() => void detail.refetch()} />
      </aside>
    );
  }

  const { listing: l, priceHistory } = detail.data;
  const lastPrice = l.priceCents ? l.priceCents / 100 : 0;

  return (
    <aside className="detail" aria-label="Détail de l'annonce">
      <header>
        <strong style={{ flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.title}</strong>
        <button type="button" className="btn subtle icon" onClick={onClose} aria-label="Fermer"><X size={15} /></button>
      </header>

      {l.images.length > 0 ? (
        <div className="section">
          <div className="gallery">
            {l.images.slice(0, 6).map((src) => (
              <img key={src} src={src} alt="" loading="lazy" referrerPolicy="no-referrer" />
            ))}
          </div>
        </div>
      ) : null}

      <div className="section">
        <h3>Prix</h3>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{price(l.priceCents)}</span>
          {l.dealScore !== undefined ? (
            <Chip cls={l.dealScore >= 0.15 ? "accent" : l.dealScore <= -0.15 ? "coral" : null}>
              {l.dealScore >= 0 ? "sous" : "au-dessus de"} la médiane ({percent(Math.abs(l.dealScore))})
            </Chip>
          ) : null}
        </div>
        <div style={{ marginTop: 10 }}>
          <Sparkline points={priceHistory} />
          <div className="muted" style={{ fontSize: 10.5, marginTop: 4 }}>
            {priceHistory.length} relevé{priceHistory.length > 1 ? "s" : ""} · premier {timeAgo(l.publishedAt)} · vu {dt(l.scrapedAt)}
          </div>
        </div>
      </div>

      <div className="section">
        <h3>Caractéristiques</h3>
        <dl className="kv">
          <dt>Catégorie</dt><dd>{l.category ?? "—"}</dd>
          <dt>Ville</dt><dd>{l.location?.city ?? "—"} {l.location?.postalCode ? `(${l.location.postalCode})` : ""}</dd>
          <dt>Département</dt><dd>{l.location?.department ?? "—"}</dd>
          <dt>Vendeur</dt><dd>{l.owner?.type === "pro" ? `Pro${l.owner.name ? ` — ${l.owner.name}` : ""}` : "Particulier"}</dd>
          <dt>Publié</dt><dd>{dt(l.publishedAt)}</dd>
          <dt>Identifiant</dt><dd className="mono">{l.id}</dd>
          <dt>Source</dt><dd className="mono">{l.source}</dd>
          <dt>Pertinence</dt><dd><ScoreBar value={l.score} /></dd>
        </dl>
      </div>

      {l.body ? (
        <div className="section">
          <h3>Description</h3>
          <p className="body-text">{l.body}</p>
        </div>
      ) : null}

      {Object.keys(l.attributes).length > 0 ? (
        <div className="section">
          <h3>Attributs</h3>
          <dl className="kv">
            {Object.entries(l.attributes).map(([k, v]) => (
              <span key={k} style={{ display: "contents" }}>
                <dt>{k}</dt>
                <dd>{String(v)}</dd>
              </span>
            ))}
          </dl>
        </div>
      ) : null}

      <div className="section actions" style={{ border: "none" }}>
        <a className="btn" href={l.url} target="_blank" rel="noreferrer">
          <ExternalLink size={13} />Ouvrir sur Leboncoin
        </a>
        {l.priceCents ? (
          <button type="button" className="btn" onClick={() => onCreateWatch(lastPrice * 0.95)} title="Alerte si le prix passe sous −5 %">
            <Bell size={13} />Veille prix −5 %
          </button>
        ) : null}
      </div>
    </aside>
  );
}
