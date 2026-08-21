const eur = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const eurCents = (cents: number) => eur.format(cents / 100);

const dateFmt = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Paris" });
const timeFmt = new Intl.DateTimeFormat("fr-FR", { timeStyle: "short", timeZone: "Europe/Paris" });

export function price(cents?: number | null): string {
  return cents === undefined || cents === null ? "—" : eurCents(cents);
}

export function dt(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : dateFmt.format(d);
}

export function timeAgo(iso?: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  const min = Math.round(ms / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const j = Math.round(h / 24);
  return `il y a ${j} j`;
}

export function clock(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : timeFmt.format(d);
}

export function countdown(iso?: string | null): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "imminent";
  const min = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${min}:${String(s).padStart(2, "0")}`;
}

export function percent(x?: number): string {
  return x === undefined || x === null ? "—" : `${Math.round(x * 100)} %`;
}

export function dealLabel(x?: number): { label: string; cls: "accent" | "amber" | "coral" | null } {
  if (x === undefined || x === null) return { label: "—", cls: null };
  const pct = Math.round(x * 100);
  if (x >= 0.15) return { label: `−${pct} %`, cls: "accent" };
  if (x <= -0.15) return { label: `+${Math.abs(pct)} %`, cls: "coral" };
  return { label: `${pct >= 0 ? "−" : "+"}${Math.abs(pct)} %`, cls: null };
}
