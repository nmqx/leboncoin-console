import type { ReactNode } from "react";

export function Chip({ children, cls }: { children: ReactNode; cls?: "accent" | "amber" | "coral" | "info" | null }) {
  return <span className={`chip${cls ? ` ${cls}` : ""}`}>{children}</span>;
}

export function ScoreBar({ value, deal = false }: { value: number | null | undefined; deal?: boolean }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  const pct = Math.round(Math.max(0, Math.min(1, deal ? (value + 1) / 2 : value)) * 100);
  return (
    <span className={`scorebar${deal ? " deal" : ""}`}>
      <span className="track">
        <span className="fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="val">{deal ? `${value >= 0 ? "−" : "+"}${Math.round(Math.abs(value * 100))}%` : pct}</span>
    </span>
  );
}

export function Sparkline({ points, width = 360, height = 44 }: { points: Array<{ priceCents: number; observedAt: string }>; width?: number; height?: number }) {
  if (points.length < 2) {
    return <div className="muted" style={{ fontSize: 11 }}>Historique : {points.length <= 1 ? "point unique — pas encore de tendance" : "vide"}</div>;
  }
  const prices = points.map((p) => p.priceCents);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const coords = points.map((p, i) => `${(i * step).toFixed(1)},${(height - 6 - ((p.priceCents - min) / span) * (height - 12)).toFixed(1)}`);
  const down = prices[prices.length - 1]! <= prices[0]!;
  const color = down ? "var(--accent)" : "var(--amber)";
  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Historique de prix">
      <polyline points={coords.join(" ")} fill="none" stroke={color} strokeWidth="1.5" />
      {coords.map((c, i) => {
        const [x, y] = c.split(",");
        return <circle key={i} cx={x} cy={y} r="1.8" fill={color} />;
      })}
    </svg>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      className={`toggle${on ? " on" : ""}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    />
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="state">
      <div>{title}</div>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: { code: string; message: string; correlationId?: string }; onRetry?: () => void }) {
  return (
    <div className="state error">
      <div style={{ fontWeight: 600 }}>{error.code}</div>
      <div style={{ fontSize: 12, maxWidth: 480, textAlign: "center" }}>{error.message}</div>
      {error.correlationId && error.correlationId !== "-" ? (
        <div className="mono" style={{ fontSize: 10 }}>corr. {error.correlationId}</div>
      ) : null}
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>Réessayer</button>
      ) : null}
    </div>
  );
}

export function Loading({ label = "Chargement…" }: { label?: string }) {
  return (
    <div className="state" aria-busy="true">
      <span className="muted">{label}</span>
    </div>
  );
}
