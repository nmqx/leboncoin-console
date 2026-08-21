import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, Sparkles, ShieldAlert, RefreshCw } from "lucide-react";
import type { Conversation, Message } from "@lbc/contracts";
import { api, ApiError } from "../../api";
import { timeAgo, dt, price } from "../../format";
import { Chip, EmptyState, ErrorState, Loading, Toggle } from "../../components/ui";

const CLASSIF_LABEL: Record<string, string> = {
  question: "question",
  offre: "offre",
  "rendez-vous": "rendez-vous",
  spam: "spam",
  autre: "autre",
};

export default function InboxView() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["conversations"], queryFn: api.conversations });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [llmPreview, setLlmPreview] = useState<{ reply: string; classification: string | null; confidence: number } | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const msgsRef = useRef<HTMLDivElement>(null);

  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const automation = status.data?.automation.enabled ?? false;
  const killSwitch = status.data?.automation.killSwitch ?? false;

  const conversations: Conversation[] = list.data?.conversations ?? [];
  const thread = useQuery({
    queryKey: ["conversation", selectedId],
    queryFn: () => api.conversation(selectedId!),
    enabled: !!selectedId,
  });

  useEffect(() => {
    if (!selectedId && conversations.length > 0) setSelectedId(conversations[0]!.id);
  }, [conversations, selectedId]);

  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight });
  }, [thread.data]);

  const invalidateThread = () => {
    void qc.invalidateQueries({ queryKey: ["conversation", selectedId] });
    void qc.invalidateQueries({ queryKey: ["conversations"] });
  };

  const send = useMutation({
    mutationFn: (body: string) => api.reply(selectedId!, body, { dedupeKey: `ui-${Date.now()}` }),
    onSuccess: () => {
      setDraft("");
      setLlmPreview(null);
      setSendError(null);
      invalidateThread();
    },
    onError: (err) => setSendError(err instanceof ApiError ? `${err.code} : ${err.message}` : (err as Error).message),
  });

  const preview = useMutation({
    mutationFn: () => api.previewReply(selectedId!),
    onSuccess: (res) => {
      setLlmPreview(res.draft);
      setDraft(res.draft.reply);
    },
    onError: (err) => setSendError(err instanceof ApiError ? `${err.code} : ${err.message}` : (err as Error).message),
  });

  const setAutomation = useMutation({
    mutationFn: (on: boolean) => (on ? api.automation.enable() : api.automation.disable()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["status"] }),
  });

  // Sync live : rejeu du contrat capturé (routing messagerie indépendant)
  const sync = useMutation({
    mutationFn: () => api.conversationsSync(),
    onSuccess: (res) => {
      invalidateThread();
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  const messages: Message[] = thread.data?.messages ?? [];

  return (
    <>
      <div className="view-head">
        <h1>Messagerie</h1>
        {killSwitch ? <Chip cls="coral">kill switch — envois bloqués</Chip> : null}
        <span className="muted" style={{ fontSize: 11 }}>polling 10 min · dédupliqué par message · jamais de premier contact automatique</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn"
          disabled={sync.isPending || killSwitch}
          onClick={() => sync.mutate()}
          title="Synchroniser l'inbox réelle (rejeu du contrat capturé, routing messagerie)"
        >
          <RefreshCw size={13} className={sync.isPending ? "spin" : undefined} />
          {sync.isPending ? "Sync…" : "Synchroniser"}
          {sync.isSuccess ? ` · ${sync.data?.synced ?? 0}` : ""}
        </button>
        {sync.isError ? (
          <Chip cls="coral">{sync.error instanceof ApiError ? sync.error.code : "erreur sync"}</Chip>
        ) : null}
        <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--text-2)" }}>
          <Toggle on={automation} label="Automation des réponses" onChange={(v) => setAutomation.mutate(v)} />
          Réponses automatiques {automation ? "activées" : "désactivées"}
        </label>
      </div>

      <div className="view-body">
        <div className="inbox-list" role="list">
          {list.isPending ? <Loading /> :
           list.isError ? <ErrorState error={{ code: "Erreur", message: (list.error as Error).message }} /> :
           conversations.length === 0 ? <EmptyState title="Aucune conversation" /> :
           conversations.map((c) => (
            <div
              key={c.id}
              role="listitem"
              className={`inbox-item${c.id === selectedId ? " selected" : ""}`}
              onClick={() => { setSelectedId(c.id); setLlmPreview(null); setSendError(null); }}
            >
              <div className="top">
                <span className="who">{c.otherUser}</span>
                <span className="when" title={dt(c.lastMessageAt)}>{timeAgo(c.lastMessageAt)}</span>
              </div>
              <div className="ad" title={c.listingTitle ?? ""}>{c.listingTitle ?? "—"}</div>
              <div className="badges">
                {c.unreadCount > 0 ? <Chip cls="accent">{c.unreadCount} non lu{c.unreadCount > 1 ? "s" : ""}</Chip> : null}
                {c.classification ? (
                  <Chip cls={c.classification === "spam" ? "coral" : null}>{CLASSIF_LABEL[c.classification] ?? c.classification}</Chip>
                ) : null}
                {c.listingPriceCents ? <span className="muted" style={{ fontSize: 10.5 }}>{price(c.listingPriceCents)}</span> : null}
              </div>
            </div>
          ))}
        </div>

        <div className="thread">
          {thread.isPending || !selectedId ? <Loading /> :
           thread.isError ? <ErrorState error={{ code: "Erreur", message: (thread.error as Error).message }} onRetry={() => void thread.refetch()} /> :
           !thread.data ? <EmptyState title="Sélectionnez une conversation" /> : (
            <>
              <div className="view-head" style={{ height: 40 }}>
                <strong>{thread.data.conversation.otherUser}</strong>
                <span className="muted" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {thread.data.conversation.listingTitle}
                </span>
                {thread.data.conversation.classification ? (
                  <Chip cls={thread.data.conversation.classification === "spam" ? "coral" : null}>
                    {CLASSIF_LABEL[thread.data.conversation.classification] ?? thread.data.conversation.classification}
                  </Chip>
                ) : null}
                <span className="spacer" />
                {thread.data.listing ? (
                  <a href={thread.data.listing.url} target="_blank" rel="noreferrer" className="btn subtle" style={{ fontSize: 11 }}>
                    voir l'annonce
                  </a>
                ) : null}
              </div>

              <div className="msgs" ref={msgsRef}>
                {messages.map((m) => (
                  <div key={m.id} className={`msg ${m.direction}`} title={dt(m.sentAt)}>
                    <div>{m.body}</div>
                    <div className="meta">
                      <span>{timeAgo(m.sentAt)}</span>
                      {m.auto ? <span>auto</span> : null}
                      {m.deliveryStatus === "simulated" ? <span title="Mode fixtures : aucun envoi réel">simulé</span> : null}
                      {m.deliveryStatus === "failed" ? <span style={{ color: "var(--coral)" }}>échec</span> : null}
                    </div>
                  </div>
                ))}
              </div>

              {sendError ? (
                <div className="banner coral" style={{ margin: "0 12px 8px" }}>
                  <ShieldAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} />{sendError}
                </div>
              ) : null}

              {llmPreview ? (
                <div className="banner accent" style={{ margin: "0 12px 8px", flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <Sparkles size={14} />
                    <strong>Brouillon LLM</strong>
                    <span style={{ fontSize: 11 }}>classification : {llmPreview.classification ?? "—"} · confiance {Math.round(llmPreview.confidence * 100)} %</span>
                  </div>
                  <div style={{ color: "var(--text-2)", fontSize: 12 }}>{llmPreview.reply}</div>
                  <div style={{ fontSize: 10.5, color: "var(--text-3)" }}>Relisez avant envoi — le brouillon est chargé dans le composeur.</div>
                </div>
              ) : null}

              <div className="composer">
                <textarea
                  value={draft}
                  placeholder="Réponse… (Entrée pour envoyer, Maj+Entrée pour un saut de ligne)"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && draft.trim()) {
                      e.preventDefault();
                      send.mutate(draft.trim());
                    }
                  }}
                  aria-label="Réponse"
                />
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <button
                    type="button"
                    className="btn"
                    disabled={preview.isPending}
                    onClick={() => preview.mutate()}
                    title="Générer un brouillon avec le LLM (configuré dans Système)"
                  >
                    <Sparkles size={13} />{preview.isPending ? "…" : "Brouillon LLM"}
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!draft.trim() || send.isPending || killSwitch}
                    onClick={() => send.mutate(draft.trim())}
                  >
                    <Send size={13} />Envoyer
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
