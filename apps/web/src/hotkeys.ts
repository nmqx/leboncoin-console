import { useEffect, useRef } from "react";

/**
 * Système clavier global. Les vues enregistrent des raccourcis ; le shell
 * gère 1–6 (navigation), ? (aide), Échap (fermeture contextuelle).
 * Les saisies dans des champs ne déclenchent jamais de raccourci.
 */
type Handler = (e: KeyboardEvent) => void;

export interface HotkeyDef {
  key: string;
  description: string;
  handler: Handler;
}

const registry = new Map<string, HotkeyDef>();
const listeners = new Set<() => void>();

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
}

export function registerHotkey(def: HotkeyDef): () => void {
  registry.set(def.key, def);
  listeners.forEach((l) => l());
  return () => {
    registry.delete(def.key);
    listeners.forEach((l) => l());
  };
}

export function activeHotkeys(): HotkeyDef[] {
  return [...registry.values()];
}

export function useHotkey(def: HotkeyDef) {
  const ref = useRef(def);
  ref.current = def;
  useEffect(() => {
    return registerHotkey({
      ...ref.current,
      handler: (e) => ref.current.handler(e),
    });
  }, [def.key]);
}

export function installGlobalKeyboard(onHelp: () => void): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (isTyping(e.target)) {
      if (e.key === "Escape") (e.target as HTMLElement).blur();
      return;
    }
    if (e.key === "?") {
      e.preventDefault();
      onHelp();
      return;
    }
    const def = registry.get(e.key);
    if (def) {
      e.preventDefault();
      def.handler(e);
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

/** Focus sur le premier élément [data-autofocus] de la vue active. */
export function focusQueryInput(): void {
  const el = document.querySelector<HTMLElement>("[data-autofocus]");
  if (el) {
    el.focus();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
  }
}
