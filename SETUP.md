# SETUP.md — Reprendre le développement sur un autre PC

Ce guide démarre le projet **à zéro sur une nouvelle machine** et remet le
dev en route. La documentation de passation complète (architecture, contrats
reversés, vérités acquises, statut) vit dans **README.md** — lis-le après
celui-ci, surtout §5 (contrats) et §6 (pièges).

---

## 1. Prérequis

| Outil | Version | Notes |
| --- | --- | --- |
| Node.js | **24+** | `node -v` — requis (node:sqlite natif) |
| Git | quelconque | |
| Chrome | installé | pour la connexion Leboncoin (DevTools) |
| PowerShell | 5+ | inclus à Windows |

Pas de Python, pas de base externe : SQLite natif (`node:sqlite`), WAL.

## 2. Installation

```powershell
git clone https://github.com/<ton-user>/leboncoin-console.git
cd leboncoin-console
npm install          # workspaces : server + web + contracts + fixtures
npm test             # 99 tests offline doivent être verts — zéro réseau
npm run build        # vite build + typecheck server
```

Si les 99 tests passent, la machine est saine.

## 3. Premier démarrage

```powershell
# mode hors-ligne (données d'exemple, aucun réseau) :
npm run dev

# mode live (vraies annonces Leboncoin) :
$LBC_MODE="live"; npm run dev:server    # PowerShell
# ou bash : LBC_MODE=live npm run dev:server
```

- Console : http://localhost:5173 (dev) ou http://127.0.0.1:8787 (build,
  le backend sert le frontend construit).
- Démarrage automatique au login : `powershell -ExecutionPolicy Bypass
  -File scripts\install-windows.ps1` (tâche planifiée, repli dossier Startup).

## 4. Les secrets ne voyagent pas — c'est voulu

**`data/` n'est pas dans le repo** et le coffre est chiffré **DPAPI
CurrentUser** : les clés sont liées à la machine ET au compte Windows qui les
a créées. Sur un nouveau PC, tout est à ré-importer (c'est une sécurité, pas
un bug) :

| Secret | Où le remettre | Comment |
| --- | --- | --- |
| Session Leboncoin | Système → « Ouvrir Chrome & se connecter » | Chrome s'ouvre sur leboncoin.fr — connecte-toi, l'import est automatique (~4 s), parcoure l'inbox et envoie UN message pour capter les contrats d'envoi, puis « Terminer » |
| Clé AnySolver | Système → AnySolver → clé + « Vérifier solde » | ou `POST /api/v1/diagnostics/anysolver {"apiKey":"…"}` |
| Clé LLM (optionnel) | Système → LLM → « Tester » | active preview-reply, llmFilter, auto-réponses |
| Proxy (optionnel) | Système → Proxy → tester + « Stocker chiffré » | sticky obligatoire pour DataDome — le test 3 sondes le vérifie |

Le profil Chrome de connexion vit dans `data/chrome-profile/` : il survit aux
redémarrages sur LA MÊME machine, ne se transfère pas proprement — reconnexion
en 2 clics sur la nouvelle.

## 5. Vérifier que le live marche (5 minutes)

```bash
# 1. status
curl -s http://127.0.0.1:8787/api/v1/status          # mode: live
# 2. une recherche réelle (job direct)
curl -s -X POST http://127.0.0.1:8787/api/v1/search-jobs \
  -H "Content-Type: application/json" \
  --data @- <<'EOF'
{"query":"vélo route","maxItems":10}
EOF
# → status completed, itemsFound 10
# 3. session
curl -s http://127.0.0.1:8787/api/v1/session/status  # imported: true
# 4. sync inbox (après connexion chrome)
curl -s -X POST http://127.0.0.1:8787/api/v1/conversations/sync
```

Piège Git Bash : `curl -d` avec des accents casse `Content-Length` —
toujours `--data @fichier` pour les payloads accentués.

## 6. Boucle de développement

```powershell
npm run dev            # server (tsx watch) + web (vite) en parallèle
npm test               # vitest — 99 offline, rapides, aucun réseau
npx playwright test    # 7 e2e — serveur lancé requis (build + npm start)
npm run typecheck      # server + web, strict
```

- Le serveur redémarre proprement : `taskkill //F //IM node.exe` puis relance
  (rituel documenté README §3).
- Base : `data/console.db` (SQLite WAL) — inspectable avec n'importe quel
  client sqlite. Supprime-le pour repartir d'une base vierge (fixtures
  réamorçées au boot en mode non-live).
- Événements en direct : onglet réseau sur `GET /api/v1/events` (SSE), ou la
  barre d'état de la console.

## 7. Où continuer

Le README §2 « Reste à faire » est la liste vivante. En bref aujourd'hui :
clé LLM à fournir (active brouillons + auto-réponses), premier tir réel de
l'auto-réponse à faire sur une conversation choisie, solve AnySolver armé
mais jamais requis. Toute la connaissance coûteuse (contrats API, pièges
DataDome/CDP/chrome, format des requêtes messagerie) est dans README §5–§6.

## 8. Règles d'hygiène du repo

- Aucun secret dans git : `.gitignore` bloque `data/`, `.env`, et les motifs
  `*login_pass*`/`*credentials*`. Le fichier `data/` contient des tokens
  réels — ne le commit JAMAIS, même en privé.
- Avant tout push public : `git log --all -p | grep -E "<pattern-de-secret>"`
  (l'historique initial a été squashed exactement pour ça).
- Les identifiants partagés en conversation sont considérés grillés —
  révoque et régénère avant usage sérieux.
