import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity, Search, Radar, Inbox, Webhook, Settings2, Keyboard, X,
} from "lucide-react";
import { api } from "./api";
import { useEvents } from "./events";
import { countdown } from "./format";
import { installGlobalKeyboard, activeHotkeys } from "./hotkeys";
import SearchView from "./features/search/SearchView";
import WatchesView from "./features/watches/WatchesView";
import InboxView from "./features/inbox/InboxView";
import WebhooksView from "./features/webhooks/WebhooksView";
import SettingsView from "./features/settings/SettingsView";

const VIEWS = [
  { id: "search", label: "Recherche", icon: Search, key: "1" },
  { id: "watches", label: "Veilles", icon: Radar, key: "2" },
  { id: "inbox", label: "Messagerie", icon: Inbox, key: "3" },
  { id: "webhooks", label: "Webhooks", icon: Webhook, key: "4" },
  { id: "settings", label: "Système", icon: Settings2, key: "5" },
] as const;

type ViewId = (typeof VIEWS)[number]["id"];

function viewFromHash(): ViewId {
  const h = window.location.hash.replace(/^#\/?/, "");
  const found = VIEWS.find((v) => v.id === h);
  return found ? found.id : "search";
}

export default function App() {
  const [view, setView] = useState<ViewId>(viewFromHash);
  const [helpOpen, setHelpOpen] = useState(false);
  const [, forceTick] = useState(0);

  const { data: status } = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 15_000 });
  const { data: diagnostics } = useQuery({ queryKey: ["diagnostics"], queryFn: api.diagnostics, refetchInterval: 30_000 });
  const { last, connected } = useEvents();

  // horloge 1 s pour le compte à rebours du scheduler
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const go = useCallback((id: ViewId) => {
    window.location.hash = `#/${id}`;
    setView(id);
  }, []);

  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => installGlobalKeyboard(() => setHelpOpen((o) => !o)), []);

  // Échap ferme l'aide (et toute surcouche future)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHelpOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // raccourcis fixes 1–5
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
      const target = VIEWS.find((v) => v.key === e.key);
      if (target) go(target.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  const killSwitch = status?.automation.killSwitch ?? false;
  const automation = status?.automation.enabled ?? false;
  const hotkeyList = useMemo(() => activeHotkeys(), [helpOpen, view]);

  return (
    <div className="shell">
      <nav className="rail" aria-label="Navigation principale">
        <div className="rail-logo" title="Console Leboncoin"><Activity size={18} /></div>
        {VIEWS.map((v) => {
          const Icon = v.icon;
          return (
            <button
              key={v.id}
              type="button"
              className={view === v.id ? "active" : ""}
              onClick={() => go(v.id)}
              title={`${v.label} (${v.key})`}
              aria-label={v.label}
              aria-current={view === v.id ? "page" : undefined}
            >
              <Icon size={17} strokeWidth={1.7} />
              <span className="rail-key">{v.key}</span>
            </button>
          );
        })}
        <div className="rail-spacer" />
        <button type="button" onClick={() => setHelpOpen(true)} title="Raccourcis (?)" aria-label="Raccourcis clavier">
          <Keyboard size={17} strokeWidth={1.7} />
        </button>
      </nav>

      <div className="main">
        {view === "search" ? <SearchView /> : null}
        {view === "watches" ? <WatchesView /> : null}
        {view === "inbox" ? <InboxView /> : null}
        {view === "webhooks" ? <WebhooksView /> : null}
        {view === "settings" ? <SettingsView /> : null}
      </div>

      <footer className="statusbar">
        <span><span className={`dot ${killSwitch ? "alert" : connected ? "on" : "off"}`} />{killSwitch ? "KILL SWITCH" : status?.mode ?? "…"}</span>
        <span>planif. {status?.scheduler.running ? countdown(status.scheduler.nextRunAt) : "arrêtée"}</span>
        <span>{automation ? "automation ON" : "automation OFF"}</span>
        <span>{status ? `${status.counters.listings} annonces · ${status.counters.watches} veilles · ${status.counters.pendingDeliveries} livraisons` : "…"}</span>
        {diagnostics?.llmConfigured ? <span className="chip amber">LLM HTTP non chiffré</span> : null}
        {killSwitch ? <span className="chip coral">tout est suspendu</span> : null}
        <span className="event-tick">
          {last ? `${new Date(last.createdAt).toLocaleTimeString("fr-FR")} · ${last.type}` : connected ? "connecté — en attente d'événements" : "flux événements déconnecté"}
        </span>
        <span className="muted">v{status?.version ?? "?"}</span>
      </footer>

      {helpOpen ? (
        <div className="overlay" onClick={() => setHelpOpen(false)} role="dialog" aria-label="Raccourcis clavier">
          <div className="panel" onClick={(e) => e.stopPropagation()} style={{ padding: 0 }}>
            <div className="panel-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Raccourcis</span>
              <button type="button" className="btn subtle icon" onClick={() => setHelpOpen(false)} aria-label="Fermer"><X size={14} /></button>
            </div>
            <div style={{ padding: "0 20px 16px" }}>
              {[
                { k: "1 – 5", d: "Changer de vue" },
                { k: "/", d: "Focus recherche" },
                { k: "j / k", d: "Ligne suivante / précédente" },
                { k: "Entrée", d: "Ouvrir le détail de la ligne" },
                { k: "Échap", d: "Fermer le détail / quitter le champ" },
                ...hotkeyList.map((h) => ({ k: h.key, d: h.description })),
                { k: "?", d: "Cette aide" },
              ].map((row) => (
                <div className="kbd-row" key={row.k + row.d}>
                  <span>{row.d}</span>
                  <kbd>{row.k}</kbd>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
