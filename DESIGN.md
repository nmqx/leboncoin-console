# DESIGN.md — Console locale Leboncoin

## Scène

Un opérateur devant un écran de bureau, dans une pièce peu éclairée, avec
plusieurs centaines de lignes à parcourir. La console doit rester lisible après
une heure de veille : contrastes forts, mouvement utilitaire uniquement.

## Couleur (OKLCH)

| Token | Valeur | Usage |
| --- | --- | --- |
| `--bg-0` | `oklch(0.155 0.012 292)` | fond général — graphite teinté prune/bleu, jamais noir pur |
| `--bg-1` | `oklch(0.185 0.013 290)` | panneaux, barres |
| `--bg-2` | `oklch(0.225 0.015 288)` | survol, entrées actives, champs |
| `--bg-inset` | `oklch(0.13 0.01 292)` | zones enfoncées (code, moniteur) |
| `--line` | `oklch(0.30 0.015 288)` | bordures 1 px |
| `--text-1` | `oklch(0.93 0.008 95)` | texte principal — clair teinté, jamais blanc pur |
| `--text-2` | `oklch(0.78 0.012 95)` | texte secondaire |
| `--text-3` | `oklch(0.62 0.012 95)` | métadonnées, en-têtes de colonnes |
| `--accent` | `oklch(0.79 0.13 140)` | lichen / vert minéral — actions, sélection, focus |
| `--accent-dim` | `oklch(0.35 0.06 140)` | fonds teintés accent |
| `--amber` | `oklch(0.80 0.13 80)` | alertes, budgets, avertissements |
| `--coral` | `oklch(0.70 0.17 25)` | erreurs, 403 non résolus, kill switch |
| `--info` | `oklch(0.75 0.10 250)` | information neutre, liens |

Contraste minimal 4.5:1 pour tout texte. Les couleurs ne portent jamais
d'information seules — toujours doublées d'un texte ou d'une icône.

## Typographie

- Pile : `"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`.
- Mono (ID, signatures, logs) : `"Cascadia Mono", Consolas, monospace`.
- Tailles : 13 px corps, 12 px tableaux et métadonnées, 11 pxmajuscules espacées pour les libellés de colonnes, 16–18 px titres de panneau.
- Chiffres tabulaires (`font-variant-numeric: tabular-nums`) dans toutes les tables.

## Densité et mise en page

- Rangées : 38 px (tableaux), 34 px minimum (listes compactes).
- Layout : rail de navigation vertical (48 px) + zone liste + panneau détail
  (420 px) à droite. Panneau détail repliable ; sous 900 px il devient un
  tiroir plein écran.
- Panneaux plats : fond `--bg-1`, bordure 1 px `--line`, rayon 4 px. Pas de
  cartes imbriquées, pas d'ombres portées décoratives.
- Espacements en pas de 4 px (4, 8, 12, 16, 24).

## Mouvement

- Transitions 140–180 ms `ease-out` sur couleur, opacité, transform discret.
- Aucun mouvement décoratif : pas de parallaxe, pas d'animations d'entrée en
  cascade, pas de skeleton pulsé plus de 2 cycles.
- Le changement de valeur (prix) clignote une fois en accent (fade 160 ms).

## États

- Loading : ligne de progression fine (2 px) en haut de la zone, texte d'état.
- Empty : message court + action possible (« Aucune veille — `N` pour créer »).
- Error : panneau `--coral` bordé, code, message, `correlationId`, action réessayer.
- 403 : jamais silencieux — ligne d'état dédiée « Challenge DataDome en cours » ou erreur structurée.

## Écrans

1. **Recherche** — barre de requête + filtres (prix, vendeur, livraison,
   département), tableau virtualisé multi-tri, export CSV/JSON, comparaison
   2–4 annonces, panneau détail (galerie lazy, historique de prix, score, actions).
2. **Veilles** — liste des recherches sauvegardées : fréquence, dernier run,
   nouveaux résultats, run manuel, activation.
3. **Détail annonce** — galerie lazy, description, historique de prix, score de
   pertinence et bonne affaire, actions (ouvrir, veille prix, comparer).
4. **Messagerie (Inbox)** — conversations, classification, contexte annonce,
   réponse manuelle, aperçu LLM, automation on/off.
5. **Webhooks** — Discord et HTTP génériques, historique des livraisons,
   rejeu manuel, test.
6. **Système** — session, proxy + test sticky, AnySolver (solde, budget), LLM
   (+ bandeau HTTP non chiffré permanent), automation, kill switch, rétention.

## Accessibilité

- Tout actionnable au clavier, focus visible (contour `--accent` 1 px + offset).
- `prefers-reduced-motion` : transitions réduites à l'opacité.
- Libellés `aria` sur les contrôles icône-seuls.
