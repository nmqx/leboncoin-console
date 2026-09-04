# Console locale Leboncoin — HANDOFF / PASSATION

> **Document de passation.** Écrit pour qu'un modèle (ou un humain) reprenne le
> projet à froid, sans l'historique de session. Tout ce qui a été appris aux
> dépens d'heures de debug est écrit ici. Lis ce fichier en entier avant de
> toucher au code.

---

## 1. Ce que c'est

Application locale Windows mono-utilisateur qui surveille Leboncoin :

- recherche paginée en direct (scraping autorisé du site public),
- veilles cadencées (10 min + jitter), déduplication, historique de prix,
- messagerie : lecture de l'inbox réel, envoi réel par rejeu de contrats capturés,
- réponses assistées LLM (brouillon manuel + auto-réponse câblée, OFF par défaut),
- webhooks Discord + HTTP signé HMAC, outbox transactionnel,
- console web sombre, dense, clavier d'abord, en français.

Stack : **Node 24 + TypeScript strict**, Fastify 5, SQLite (`node:sqlite`, WAL),
**wreq-js 3.1.0** (cœur Rust, empreinte TLS/HTTP2 Chrome) pour tout le HTTP
sortant vers Leboncoin, React 19 + Vite + TanStack Query/Virtual pour le front.
Secrets chiffrés **DPAPI CurrentUser** (`@primno/dpapi`).

Machine : Windows 11, Git Bash, Node v24.14.1, Chrome 151.
Repo public : **github.com/nmqx/leboncoin-console** (historique écrasé puis
repoussé propre, vérifié sans fuite ; les secrets ne voyagent de toute façon
jamais — DPAPI lié au compte machine, `data/` ignoré). Reprise sur un autre
PC : voir `SETUP.md`.

---

## 2. Statut — ce qui marche (vérifié en live), ce qui reste

### ✅ Fonctionnel et testé en direct

| Fonction | Preuve |
| --- | --- |
| Recherche live `__NEXT_DATA__` | 35 annonces réelles en <400 ms, direct et via proxy |
| Déduplication multi-IP | job direct 35 nouvelles, job proxy 35 trouvées / 2 nouvelles |
| DataDome : détection + classification | rt=i / t=it / interstitial / rt=c / t=bv |
| Stress test direct vs proxy (12+12) | sessions fraîches : 8/8 chaque bras, 0 challenge |
| Connexion Chrome par DevTools (CDP brut) | login réel, cookies + 129 requêtes capturées |
| Session auto-importée (bearer + cookies) | userId `<userId>`, JWT décodé, coffre DPAPI |
| Sync inbox live | 33 conversations réelles en base |
| Threads live | messages réels mappés (julien ✓, directions correctes) |
| Envoi réel | **testé live 2×** : message visible dans le thread upstream ciblé (bug de ciblage initial trouvé et corrigé, voir §6.13) |
| AnySolver | clé en coffre, solde vérifié **5,00 $** ; solve armé (aucun challenge rencontré à ce jour — la chaîne n'a jamais dû tirer) |
| Démarrage au login | **installé** : tache planifiée refusée par la politique machine (accès refusé sans élévation) → lanceur `LeboncoinConsole.vbs` dans `shell:startup` (aucun admin requis) ; `start-windows.ps1` testé (détection serveur déjà lancé ✓, ouverture interface ✓) |
| Backtest complet 21/08 | moteur direct 35/4 nouvelles, moteur proxy 35/2 nouvelles (dédup inter-IP ✓), stress 8/8 direct **et** 8/8 proxy, 0 challenge |
| Filtres Leboncoin intégrés (21/08 soir) | **tous vérifiés en live** : catégorie (carte réelle 1–33), prix, vendeur (`owner_type` — écho muet mais actif, prouvé par les compteurs), livrable, urgent, offres/demandes, attributs de plage (`square`, `rooms`, `mileage`, `regdate`…) — UI recherche + veilles, ranges dynamiques par famille (immobilier/véhicules). Test live : 35 iPhone, 100 % cat 17, 100 % private, ≤ 800 €, livrables |
| Veilles personnalisables (21/08 soir) | création/édition complète (bouton **modifier** visible par ligne) : requête, prix, vendeur, dept, livrable, **cadence par veille**, **seuil « top % affaire »** (`SearchSpec.dealThreshold` — ne garde que les annonces ≥ X % sous la médiane, appliqué côté engine fixtures ET live) ; bouton lancer réactif (spinner + état par ligne) |
| Anti-faux positifs (21/08 nuit) | **deux couches** : règles déterministes toujours actives (`filterJunk` défaut true : ≤ 1 €, échange/troc/don dans le titre) + **filtre LLM sémantique optionnel** (`llmFilter: true`, un seul appel groupé par run — « Just Dance - Nintendo Switch » n'est pas une console Switch ; réponse illisible/échec LLM = tout conservé, jamais bloquant). **maxItems défaut 10** partout (10 plus récentes par run, plafond respecté dans la page, vérifié live : gardées=10) |
| Auto-réponses + auto-sync (22/08) | `AutoResponder` (`jobs/auto-responder.ts`) : sync inbox à chaque tick du scheduler + pipeline complet — brouillon LLM validé → envoi réel, limites 10/h/conversation et 100/j, jamais de premier contact, classification spam = pas d'envoi, idempotence `auto-<idMsg>`, audit + webhooks reply.sent/failed. Automation OFF par défaut ; toggle Messagerie ou `POST /conversations/auto-process`. **Non tiré en live sur le compte réel, sur demande explicite de l'opérateur** — les briques sous-jacentes (fetchConversations/sendMessage) sont elles entièrement vérifiées |
| DataDome sous blocage réel (22/08) | burst volontaire de 90 : blocage constaté en pleine salve (15/30 puis 0/30) **pendant que les jobs de recherche passaient** — l'engine a traversé la fenêtre sans solve ni failover (les vraies URLs de l'engine ≠ URLs du stress). Le messaging a pris un 403 transitoire dans la fenêtre → retry backoff 2,5–4 s ajouté à `fetchConversations`. Le solve AnySolver reste armé mais **jamais tiré en réel** — aucun challenge n'a atteint l'engine |
| MCP local (22/08) | **opérationnel** : `npm run mcp` — serveur stdio JSON-RPC sans dépendance, 7 outils read-only (initialize, tools/list, tools/call testés en JSON-RPC brut contre la base réelle) |
| Playwright e2e (22/08) | **7/7 verts** : chargement+rail+statusbar, navigation clavier 1–5, `/` focus, aide `?` + Échap (fermeture ajoutée), table de recherche réelle, sections Système, édition de veille. Piège : attendre le montage des listeners React avant les keypress |
| Rétention (22/08) | exécutée réellement (55 lignes purgées, aucune donnée utile — base jeune), auditée `retention.manual_run` |
| Rafraîchissement bearer | `refreshed: true` en live, sync OK après |
| 99 tests offline + 7 e2e | vitest vert, playwright vert, typecheck server+web propre |
| Console web | 6 écrans vérifiés en captures d'écran, données réelles |
| UI recherche enrichie (22/08) | panneau détail 420→**540 px** (galerie plus large, le milieu n'est plus vide), colonne **vignette photo** (1ʳᵉ image, 46×34, lazy) en tête de tableau + colonne **Ville** dédiée ; vérifié headless (largeur 540, vignettes rendues, capture `data/shots/05-search-rich.png`) et Playwright 7/7 |
| UI messagerie polish (22/08) | bulles de chat vraies (coins 3/10 asymétriques, bordures cadre supprimées, méta alignée à droite sur les sortantes), puits de messages sur fond `--bg-inset`, liste inbox : barre d'accent sur la sélection + point non-lu + prénom en plus clair, composeur hiérarchisé (Brouillon LLM en subtle, Envoyer en primary). Vérifié : styles calculés in/out, scroll thread, capture `data/shots/06-inbox-polish.png`, Playwright 7/7 |
| LLM gateway opérationnelle (22/08) | clé fournie par l'opérateur → coffre DPAPI ; gateway **OpenAI-compatible** (`/v1/chat/completions`, `Authorization: Bearer`, modèle `gemini-3.7-flash-high`) — le client initial parlait Anthropic `/v1/messages`, corrigé. Base URL dans `apps/server/.env` (`LLM_BASE_URL`, ignoré par git, piège dotenv : chargé depuis `apps/server/`, pas la racine). Diagnostics « pong » 1,5 s ; **filtre sémantique vérifié en live** : requête « nintendo switch » + `llmFilter` → seules des consoles réelles retenues (les jeux/accessoires « Just Dance », « Écran de switch », « Manettes switch » exclus). `Authorization` déjà rédigé dans les logs. Usage limité au filtrage sur demande de l'opérateur |
| Fix bouton « Tester » LLM (22/08) | le clic UI renvoyait `Body cannot be empty when content-type is set to 'application/json'` — le client envoyait le header JSON sans body et Fastify refuse. **Double fix** : `api.ts` ne pose `Content-Type` qu'avec un body, et `server.ts` tolère un corps JSON vide (content-parser dédié — protège aussi sync/refresh/cancel appelés sans body). Vérifié sur le **vrai bouton** dans l'UI : « OK — gemini-3.7-flash-high · ~2 s · pong » |
| Config persistée `console.config.json` (22/08) | **racine du bug de déauth** : `npm -w apps/server` lance avec cwd=apps/server, un DATA_DIR relatif créait alors une SECONDE base vierge (déauth + fixtures au premier plan). Désormais : DATA_DIR par défaut **absolu** (résolu depuis config.ts, indépendant du cwd) + `console.config.json` à la racine retient mode live, dataDir, gateway LLM, host/port — un relancement (même 2 jours après, même depuis un autre cwd) retombe sur la même base et le même mode. Priorité : env du lancement > JSON > défauts ; le JSON est réécrit à chaque boot effectif (gitignored, zéro secret) |
| Placeholders éradiqués (22/08) | le seed (annonces/conversations de démo) ne tourne **plus jamais en mode live** (`server.ts`) ; les 24 annonces fixtures + price_history de la vraie base purgées (source='fixtures') — la recherche et la messagerie n'affichent plus que du réel. Les 3 veilles existantes sont celles de l'opérateur (gardées) |
| Résultats par veille (22/08) | les résultats de veilles ne fondent plus anonymement dans le pool Recherche : table `watch_listings` (migration 3, une annonce peut matcher plusieurs veilles), `EngineRunResult.listingIds` relié au run par le scheduler / bouton lancer / jobs manuels. **Veilles : bouton « résultats · N » par ligne** → ouvre Recherche filtrée (select « Veille » dans la barre de filtres, sans relancer de run). API : `GET /listings?watchId=` + `listingCount` sur `GET /watches`. Vérifié live : veille « Vélos route » → 10 liés, filtre 10/10, handoff Veilles→Recherche OK |
| Pagination multi-pages réelle (22/08) | **maxItems > 35 fonctionne** : `page=N` + `order=desc` (JAMAIS `sort=` — piège serveur, voir §6 0b), 35/req, respiration 0,7–1,4 s, plafond ~100 pages, arrêt chronologique 14 j sur la plus récente de la page. Vérifié live : « pixel 8 » maxItems 70 → **3 pages, 69 trouvées toutes Pixel**, vue UI 64 lignes ; « iphone 13 » 105 → 3 pages/104. Les 160 annonces du flux générique injectées par les runs empoisonnés (sort=) ont été purgées |
| Filtre LLM par défaut ON (22/08) | `llmFilter` **défaut true** dans le contrat (recherche + veilles + API) — les accessoires (coque 10 €) faussent les résultats ET la médiane des % bonne affaire. Décocher la case survit au parse (opt-out explicite). Prompt renforcé : archétype **accessoire ≠ appareil** (coque/verre/écran de remplacement/batterie/câble/chargeur…) + **génération différente ≠ modèle cherché** (Pixel 8a/9 pour « pixel 8 »), doute → conservé. Vérifié live : « pixel 8 » → engine 69 → **47 retenues, toutes téléphones**, vue propre, médiane honnête. Sans clé LLM : filtre sauté, jamais bloquant. 16 accessoires historiques purgés de la base |
| Connexion = tokens seuls (22/08) | **plus besoin d'envoyer un message à la capture** : `ensureSyntheticContracts()` matérialise inbox v3 + détail HAL + envoi POST (endpoints vérifiés en live, headers standard, cookie+bearer frais du coffre au rejeu) dès l'import de session, au refresh et au boot. Une vraie capture prime si navigation il y a eu. Vérifié sur base vierge : 3 contrats créés, 2ᵉ appel no-op ; sync 33 + thread GET OK après coup |

### ⏳ Reste à faire

Les six chantiers du plan initial sont fermés. Reste, par choix de l'opérateur
ou par nécessité de circonstance :

1. **Tir réel du solve AnySolver** — impossible à provoquer sans casser
   volontairement l'engine (le fix cookies + les URLs réelles ne sont plus
   challengées). Si un jour `challenge.detected` apparaît : budget 100/jour,
   2 tentatives max, repli proxy ensuite — tout est armé.
2. **Tir réel de l'auto-réponse** — l'opérateur l'a explicitement écarté
   (« don't stress my account »). La clé LLM existe désormais (voir ligne
   « LLM gateway » du tableau) ; premier vrai test : activer automation avec
   une conversation entrante choisie. **Usage actuellement limité au
   filtrage sémantique (`llmFilter`) sur demande de l'opérateur.**

---

## 3. Démarrage rapide

```powershell
npm install
npm run dev                 # fixtures : serveur 8787 + Vite 5173
$LBC_MODE="live"; npm run dev:server    # live : vraies annonces
```

Le premier lancement live écrit **`console.config.json`** à la racine
(gitignored) : mode, `dataDir` absolu, gateway LLM, host/port s'y persistent —
un relancement plus tard, même depuis un autre dossier, retombe sur la même
base et le même mode. Priorité : env du lancement > JSON > défauts.

Prod locale (un seul port, le backend sert `apps/web/dist`) :

```powershell
npm run build               # vite build + typecheck server
npm start                   # http://127.0.0.1:8787
```

Tests : `npm test` (vitest, 88 verts, zéro réseau). Typecheck : `npm run typecheck`.

### Redémarrer le serveur pendant le dev (rituel Git Bash)

```bash
taskkill //F //IM node.exe   # tue TOUT node — assumé en dev
(LBC_MODE=live DATA_DIR=./data node --import tsx apps/server/src/index.ts > data/server.out.log 2> data/server.err.log &)
sleep 8 && curl -s http://127.0.0.1:8787/api/v1/status
```

Pièges Windows/Git Bash :
- `curl -d` avec des accents UTF-8 casse `Content-Length` → **toujours
  `--data @fichier.json`** pour les payloads accentués.
- les scripts `node -e` inline perdent les backslashes → écrire un fichier
  `.mjs`/`.mts` dans `data/` puis l'exécuter (supprimer ensuite).
- `node --import tsx fichier.mts` pour importer les modules TS du serveur
  depuis un script hors package.

---

## 4. Carte du dépôt

```
apps/server/src/
  index.ts            point d'entrée : wiring de TOUT (moteur, capture, refresh, politiques)
  server.ts           buildServer() Fastify + routes + errorHandler + static dist
  config.ts           env (Zod) + constantes (limites, rétention, cadences)
  db.ts               node:sqlite WAL + MIGRATIONS (2 migrations)
  repos.ts            tout l'accès SQL (listings, watches, jobs, conversations,
                      webhooks/outbox, settings, secrets, events, audit, captured)
  bus.ts              bus d'événements : persiste + diffuse SSE
  seed.ts             amorçage fixtures si base vide
  session.ts          import manuel/cookie-editor/playwright (légataire, le flux
                      réel est désormais chrome-devtools)
  diagnostics.ts      sondes proxy sticky (direct vs proxy, 3 sondes)
  security/           errors (AppError enveloppe), vault (DPAPI/dev), hmac, http
  domain/             proxy (parseur 2 formats), scoring (pertinence, médiane,
                      bonne affaire, tri, dédup)
  adapters/chrome/    cdp.ts (client CDP brut + lancement Chrome), capture.ts
                      (session de capture + auto-import), token-refresh.ts
  adapters/leboncoin/ wreq-transport.ts, live.ts (engine live), engine.ts
                      (fixtures), datadome.ts (classification), messaging.ts
                      (rejeu contrats : inbox v3, threads HAL, envoi)
  adapters/anysolver/ client.ts (createTask/getTaskResult, poll 3-5 s puis 2-3 s,
                      errorId≠0 dans HTTP 200, fallback providers)
  adapters/llm/       gemini.ts (client anthropique-compatible + validation JSON)
  adapters/discord/   sender.ts (embeds, 429 retry_after)
  jobs/               scheduler.ts (10 min + jitter, quarantaine), outbox.ts
                      (reprises 1/5/30/120 min puis dead-letter), retention.ts
  routes/             core (status/session/SSE/diagnostics/automation),
                      listings (search-jobs/listings/watches), messaging
                      (conversations/reply/sync/preview), webhooks, system
                      (chrome/stress/routing)
apps/web/src/         React 19 ; App.tsx (shell+rail+statusbar+aide), hotkeys.ts,
                      api.ts (client typé), events.ts (SSE), format.ts (fr-FR),
                      VirtualTable.tsx (38 px, virtualisé), features/{search,
                      watches, inbox, webhooks, settings}
packages/contracts    schémas Zod partagés (SearchSpec, Listing, Watch, …)
packages/fixtures     24 annonces FR réalistes + générateur déterministe + conversations
tests/unit|integration  12 fichiers, 88 tests
scripts/              install-windows.ps1 (tâche login), start-windows.ps1
data/                 (gitignoré) console.db, chrome-profile/, logs, shots/
```

---

## 5. Les contrats Leboncoin reversés — l'or du repo

### 5.1 Recherche (HTML public)

`GET https://www.leboncoin.fr/recherche?…` — paramètres **tous vérifiés en
live** (voir §6.15 pour la méthode et les pièges de l'écho) :

| paramètre | format | vérifié |
| --- | --- | --- |
| `text` | texte libre | ✓ |
| `category` | id (carte réelle 1–33 dans `packages/contracts/src/categories.ts`, servie par `GET /api/v1/categories`) | ✓ |
| `price` | `min-max` en euros | ✓ |
| `owner_type` | `private` \| `pro` — **écho muet mais actif** (preuve par les compteurs) | ✓ |
| `shippable` | `1` | ✓ |
| `urgent` | `1` | ✓ |
| `ad_type` | `demand` (offer = défaut) | ✓ |
| attributs | plages `key=min-max` (`square`, `rooms`, `mileage`, `regdate`…) ou enums `key=val` (`furnished=1`) | ✓ cat 10 |
| `sort`/`order` | `date`/`desc` (défaut engine), `price`/`asc` testé | ✓ |
| `o` | offset, pas de 35 ; dernière page = `max_pages` | ✓ |

**`locations=` n'accepte que des VILLES** (`d38` → 0 résultat) : les
départements restent un post-filtre local dans le LiveEngine.
`item_condition` et `since` n'ont parsé sur aucun format essayé — absents
plutôt que faux.

Réponse 200 : `__NEXT_DATA__` → `props.pageProps.searchData` :
`{ ads: RawAd[], total, total_pro, total_private, max_pages, … }`. Champs
utilisés par `normalizeAd` :
`list_id, subject, body (vide en liste), price_cents (sinon price[0][0]*100),
category_name, first_publication_date ("2026-07-05 10:39:51", heure de Paris,
convertie par dateFromParis), url, images ({urls:[…]} ou tableau plat),
attributes ([{key,value,value_label}] → value_label privilégié),
location ({city, zipcode, department_id}), owner ({type private|pro, name,
user_id, store_id})`. **Doublons d'annonces entre pages : fréquents** — la
dédup par id est indispensable.

Le vieux `POST api/search/v1/search` avec `api_key: baomubts` est **mort (404)**.

### 5.2 Messagerie — liste (API v3, bearer)

`GET https://api.leboncoin.fr/api/messaging-items-api/v3/conversations`
avec `Authorization: Bearer <luat>` + cookies. Réponse :

```jsonc
{ "metadata": { "current_user": "<uuid>", "next_page_hash": "", "size": 33 },
  "conversations": [ {
    "conversation_id": "uuid",
    "item": { "id": "2929121715", "type": "ad", "status": "absent" },
    "partners": [ { "name": "CJ76LH", "id": "uuid" } ],
    "last_message_sent_at": "2026-08-21T20:21:31.626Z",
    "unseen_counter": 0,
    "last_message_preview": "…" } ] }
```

Pagination : `?page_hash=<next_page_hash>` (vide = fini).

### 5.3 Messagerie — thread (HAL, cookies, PAS de bearer sur ce chemin)

`GET https://api.leboncoin.fr/messaging/proxy/api/v1/hal/<userId>/conversations/<convId>`
Réponse : `{ items, size, _embedded: { messages: [ {
`_links, id, text, type, date, sentAt, read, partnerRead, **outgoing** (bool →
direction), attachments, clientMessageId } ] }, _links: {message, conversation,
first, previous, next, self} }`.

### 5.4 Envoi

`POST …/hal/<userId>/conversations/<convId>/messages`
Corps : `{"clientMessageId":"<uuid À RÉGÉNÉRER>","text":"…","attachments":[]}`
→ **201** créé. Un PUT 204 sur la conversation marque lu.

### 5.5 Auth / session (la grande découverte)

- **`luat` n'est PLUS un cookie.** Il vit dans le **localStorage** du profil
  Chrome (`localStorage.getItem('luat')`), le SPA l'injecte en
  `Authorization: Bearer …`.
- JWT RS256 : `iss https://auth.leboncoin.fr`, `client_id lbc-front-web`,
  `scope … offline …`, `sub "lbc;<userId>;<storeId>"`, durée **2 h**.
- Renouvellement : pas d'endpoint à appeler — le SPA, au chargement, renouvelle
  en silence via les cookies de session d'`auth.leboncoin.fr`. Notre
  `refreshSession` ouvre donc le profil Chrome et relit localStorage.
- Les cookies utiles : `lbc_user_id, deviceId, datadome, didomi_token…` sur
  `.leboncoin.fr` + spécifiques sur `auth.leboncoin.fr`.

---

## 6. Vérités acquises (chaque point a coûté du temps — ne les réapprends pas)

0. **`npm -w apps/server` lance avec cwd=apps/server.** Tout chemin relatif
   (`./data`, dotenv) se résout depuis là, pas depuis la racine du repo — un
   DATA_DIR relatif a créé une seconde base vierge (déauth + fixtures au
   premier plan, tout semblait « perdu »). Racine du repo résolue depuis
   `config.ts` (import.meta.url) ; config persistée dans
   `console.config.json` à la racine. Le seed de fixtures ne tourne plus en
   mode live.
0b. **PIÈGE MAJEUR : tout `sort=` fait IGNORER `text`.** Avec `sort=date`
   (ou `sort=time`), le serveur répond 200 OK mais renvoie le FLUX GÉNÉRIQUE
   national (voitures, divers — mesuré : 2/35 pixels pour « pixel 8 » contre
   33/35 sans `sort=`). Symptôme en console : une requête ne ramène que 1-2
   résultats cohérents noyés dans des catégories sans rapport. `order=desc`
   seul est inoffensif ET chronologique. La pagination : `page=N` 1-based,
   fenêtres disjointes vérifiées (p1∩p2≈drift de bord, p1∩p3=0, ordre
   chronologique inter-pages confirmé). `o` et `limit` sont ignorés (35
   ads/page, fixe ; max_pages ~100). Diagnostic à retenir : des first_id
   différents entre requêtes ne prouvent RIEN (flux qui bouge) — seul le
   compte d'annonces cohérentes avec la requête fait foi. L'arrêt
   chronologique se base sur la plus RÉCENTE de la page (un ad bumpé de 50+ j
   au milieu d'une page fraîche tuait la pagination avec l'ancienne règle).
1. **Ne JAMAIS rejouer le cookie `datadome` de réponse.** Un jar partagé qui
   renvoie le cookie posé par une réponse précédente déclenche une cascade de
   403 (mesuré : 4/8 en alternance 200/403 ; sessions fraîches : 8/8, direct ET
   proxy). `WreqTransport` ne conserve plus AUCUN cookie de réponse — seuls les
   cookies explicites (session importée, challenge résolu) partent en `Cookie:`.
2. **Le burst n'est PAS le problème** (hypothèse initiale démentie) :
   8 requêtes à 150 ms d'intervalle passent à 100 % avec sessions fraîches.
   L'engine respire quand même 0,7–1,4 s entre pages, par prudence.
3. **wreq-js expose `set-cookie`** via `headers.forEach` ET `getSetCookie()`.
   L'itération écrase les valeurs multiples : dernier gagne.
4. **`--user-data-dir` RELATIF = Chrome ignore `--remote-debugging-port`
   silencieusement.** Toujours `resolve()` en absolu (`cdp.ts` le fait).
5. **Fermer Chrome par `process.kill()` détruit les cookies de session en
   mémoire.** Toujours `Browser.close` CDP d'abord (graceful, flush disque),
   kill en dernier recours. Un chrome僵尸 qui tient le profil fait dévier le
   nouveau processus → `killChromeOnProfile` nettoie avant lancement (pattern
   PowerShell : PAS de doublement des backslashes dans `-like`).
6. **CDP : les réponses de commande sont dans `result`, pas `params`** (`params`
   = événements). Un client qui lit `params` « réussit » toutes les commandes
   avec `{}` vide. Bug réel qui a coûté une reconnexion utilisateur.
7. **Chrome 151** : `Network.getAllCookies` n'existe plus sur la cible browser ;
   `Storage.getCookies` peut résoudre vide. Chaîne fiable :
   page/`Network.getCookies{urls}` → page/`Storage.getCookies` → browser/`Storage.getCookies`.
8. **Migrations** : le runner saute `id <= schema_version`. Une migration
   accidentellement retirée du tableau ne rejoue JAMAIS (version déjà notée) —
   c'est arrivé (table `captured_requests` fantôme). Toujours vérifier que le
   tableau `MIGRATIONS` contient tous les id annoncés. La base locale est à
   `schema_version = 2`.
9. **`fetch` global + `dispatcher` undici** fonctionne, mais crée l'agent depuis
   le package `undici` installé — cohérent tant qu'on passe par
   `FetchTransport`/`WreqTransport`.
10. **Le proxy fourni** (nettify) : format `user:pass@host:port`, sticky via
    `user-session-<id>-time-1`. Rotatif = refusé pour DataDome (3 IP vues sur
    3 sondes). Test sticky : `POST /diagnostics/proxy-sticky` (direct vs proxy).
11. **403 DataDome « challenge inconnu »** observé transitoire : une unique
    reprise après 1,5–3 s passe souvent. `t=bv` = IP grillée → rotation.
12. **Repli proxy automatique (21/08)** : un job de recherche en direct qui
    prend un 403 DataDome est rejoué UNE fois via le proxy stocké (hors
    politique de routage — le backup ne dépend pas de `routing.search`),
    événement `challenge.failover_proxy`, puis quarantaine si échec. Jamais
    de boucle, jamais de liste vide.
13. **Le bruit temps réel de la messagerie n'est pas un envoi.** Le flux
    capture des POST `/realtime/typing`, `/realtime/credentials`, PUT `…/read`
    (200/204). Si le sélecteur de contrat d'envoi prend « le dernier POST
    messaging », il attrape un typing et le rejeu part vers la mauvaise
    conversation (arrivé : un message de test a atterri chez CJ76LH au lieu de
    julien). Règles désormais appliquées : `classifyCaptured` exclut
    realtime/typing/read/credentials → `other` ; le contrat d'envoi est
    EXPLICITEMENT `POST …/conversations/<id>/messages` ; la substitution
    d'identifiant dans l'URL est TOUJOURS active, jamais conditionnée à des
    liens HAL.
14. **Une recherche vide ne doit JAMAIS partir upstream.** Sans `text=`,
    `/recherche` renvoie le flux générique national (catégories mélangées,
    toute la France) — du vrai contenu qui pollue la base comme du bruit
    (arrivé : 150 lignes de colocations/rameurs après des recherches vides).
    Double garde : la UI ne lance un job QUE si la requête est non vide
    (vide = filtre local uniquement), et le LiveEngine REFUSE les jobs sans
    texte (« toutes annonces » y compris) avec une erreur explicite.
15. **Reverser un paramètre d'URL Leboncoin : l'écho ment, les compteurs
    non.** `pageProps.search.filters` montre ce que le serveur PARSE — mais
    `owner_type` y est invisible alors qu'il est ACTIF (preuve : total devient
    exactement l'ancien `total_private`). Oracle fiable = comparer `total`,
    `total_pro`, `total_private` de `searchData`. Autres vérités : `locations=`
    attend des VILLES (d38 → 0 résultat) — les départements restent un
    post-filtre local ; les attributs marchent en plages génériques
    (`square=20-80`, `rooms=2-4`, `mileage=…`, vérifié cat 10) et en enums
    (`furnished=1`) ; `urgent=1`, `ad_type=demand`, `shippable=1` parsent.
    Carte catégories : `pageProps.title` (ids 1–33, réels). Et un sweep de
    ~90 requêtes rapprochées finit par déclencher DataDome (constaté) —
    cooldown quelques minutes, ou laisser le repli proxy faire.

---

## 7. Modèle de session & refresh (implémenté)

- Bundle en coffre (`secrets.lbc_session`, DPAPI) : `{ format:"chrome-devtools",
  cookies, authHeader, userId, userAgent, expiresAt, importedAt }`.
- **Auto-import** : pendant une capture, toutes les 4 s, si une requête capturée
  porte `authorization` + cookies présents → bundle chiffré, événement
  `session.imported`. Aucune action requise au-delà du login.
- **Refresh** (`POST /session/refresh`, watcher 10 min si <25 min restantes,
  401 → refresh → 1 reprise dans inbox/messages/envoi) : ouvre le profil
  (fenêtre à `--window-position=-2400,-2400`), lit `localStorage.luat` + cookies,
  met à jour le coffre. Si capture vivante → lecture directe dans son onglet.
- Échec de renouvellement silencieux (session auth expirée) → message clair :
  un clic sur « Ouvrir Chrome » (profil resté connecté) régénère tout.

---

## 8. Routage réseau & proxy

Politique par flux (`settings.routing` = `{"search":"direct","messaging":"direct"}`) :
chaque flux passe par le proxy stocké ou en direct, indépendamment. Usage
recommandé : `search=proxy` (volume), `messaging=direct` (l'IP résidentielle du
compte). UI : Système → Routage. Le proxy se stocke chiffré via
`POST /diagnostics/proxy-sticky {"save":true}`.

---

## 9. Base de données (SQLite WAL, `data/console.db`)

Migration 1 : meta, settings, secrets, listings (+index category/department/
last_seen), price_history, watches, search_jobs, conversations, messages,
webhooks, webhook_deliveries (+index due), events, audit_log, captured_requests.
Migration 2 : colonne `conversations.hal_links_json` + défaut routing.

Points sensibles :
- `listings.upsertMany` gère first_seen/last_seen, insère price_history,
  retourne `{isNew, priceChanged, previousPriceCents}` → événements + webhooks.
- `webhook_deliveries` = outbox : status pending/delivered/failed/dead,
  `nextAttemptAt` = +1/5/30/120 min (4 échecs → dead + rejeu manuel).
- `captured_requests` : les contrats reversés (kind inbox/send/api/other,
  en-têtes sans cookies — `cookie_names_json` ne garde que les NOMS).

---

## 10. API locale (résumé)

```
GET  /api/v1/status                    état + compteurs + scheduler
GET  /api/v1/diagnostics               vault, proxy/llm/anysolver configurés
POST /api/v1/diagnostics/proxy-sticky  {proxy?, save} — 3 sondes + direct
POST /api/v1/diagnostics/stress        {count≤30, useProxy, freshSession, gapMs}
POST /api/v1/diagnostics/anysolver|llm solde / ping LLM
GET  /api/v1/events                    SSE (listing.created, watch.*,
                                       message.received, reply.*, challenge.*,
                                       session.imported|refreshed, chrome.*)
POST /api/v1/search-jobs               {spec SearchSpec} → engine (fixtures|live)
GET  /api/v1/categories                carte catégories + attributs par famille
GET  /api/v1/listings[/:id]            + filtres prix/vendeur/dépt/livrable/tri, ?watchId=N (résultats d'une veille)
GET|POST|PATCH|DELETE /api/v1/watches… + POST /:id/run (spec complète :
                                       catégorie, urgent, ad_type, attributs,
                                       cadence, dealThreshold « top % »)
GET  /api/v1/conversations[/:id]       (:id = lazy-fetch thread live si vide)
POST /api/v1/conversations/sync        inbox réel → base (+webhooks message.received)
POST /api/v1/conversations/:id/reply   envoi réel en live (rejeu POST capturé)
POST /api/v1/conversations/:id/preview-reply   brouillon LLM validé (pas d'envoi)
POST /api/v1/session/chrome/start|finish|refresh, GET …/chrome/status
GET  /api/v1/session/status, DELETE /api/v1/session, POST /session/import
GET  /api/v1/captured-requests[?kind=]
GET|PUT /api/v1/system/routing         politique proxy/direct par flux
POST /api/v1/automation/enable|disable, POST /api/v1/system/kill-switch
CRUD /api/v1/webhooks… + /:id/test + /:id/deliveries + deliveries/:id/replay
POST /api/v1/system/llm-key            clé LLM → coffre
```

Erreur commune : `{error:{code,message,retryable,correlationId}}` partout.

Limites de réponse : kill switch (423) > automation (409 pour auto) >
10/h/conversation > 100/j > débounce 20 s ; idempotence via `dedupeKey`
(sha256 convId+key → INSERT OR IGNORE).

---

## 11. Front (rappel des intentions)

- Tokens OKLCH dans `styles/tokens.css` (fond graphite prune/bleu, accent
  lichen, ambre/coral alertes) ; densité 38 px ; rail 48 px ; panneau détail
  420 px, tiroir <900 px. Produit : registre « product » (voir PRODUCT.md /
  DESIGN.md — les lire avant de retoucher l'UI).
- Clavier : 1–5 vues, `/` recherche, j/k lignes, Entrée détail, Échap, `?` aide.
- SSE : invalidations TanStack Query ciblées par type d'événement (`events.ts`).
- Recherche : filtres complets (catégorie réelle, prix, vendeur, dépt,
  livrable, urgent, offres/demandes, ranges dynamiques par famille), export
  CSV/JSON, comparaison 2–4 annonces, détail avec galerie + sparkline.
- Veilles : création/édition inline complète (mêmes filtres + cadence + top %),
  bouton lancer réactif (spinner par ligne), résultat du job en chip.
- Le bouton « Synchroniser » (Messagerie) appelle /conversations/sync ;
  « Brouillon LLM » appelle preview-reply (configure la clé d'abord).

---

## 12. Procédures de test live (avec réseau réel)

1. **Backtest recherche** : `POST /search-jobs {"query":"vélo route","maxItems":70}`
   (via `--data @file`, cf. §3) → status completed, items_found>0.
2. **Stress** : bouton Système ou `POST /diagnostics/stress
   {"count":8,"freshSession":false}` — doit être 8/8 depuis le fix cookies.
3. **Session** : Système → « Ouvrir Chrome & se connecter » → l'opérateur se
   logue (auto-import en ~4 s, voir événement `session.imported`) → « Terminer ».
   La connexion SEULE suffit : les contrats messagerie (inbox v3, détail HAL,
   envoi POST) sont synthétisés à l'import depuis les endpoints vérifiés —
   aucune navigation ni envoi manuel requis (une vraie capture prime si
   l'opérateur a navigué par hasard).
4. **Sync** : `POST /conversations/sync` → 33+ conversations ; GET
   `/conversations/<id>` remplit le thread au premier appel.
5. **Refresh** : `POST /session/refresh` → `refreshed:true`, exp mise à jour.
6. **Envoi réel** (fait, à refaire au besoin) : Messagerie → conversation
   choisie → composer. Vérifier : réponse `deliveryStatus:"sent"`, puis purger
   les messages locaux de la conversation et re-GET — le message doit
   apparaître dans le thread upstream. Attention §6.13 : toujours vérifier que
   le message arrive dans la BONNE conversation.

---

## 13. Sécurité & hygiène

- Secrets uniquement en coffre DPAPI ; `.env` = config non secrète ; `data/`
  gitignoré (db, profil chrome, logs, captures d'écran).
- Logs pino redigés (cookie, authorization, apiKey, datadome…).
- `captured_requests` ne stocke PAS les valeurs de cookies (noms seulement) ;
  les `postData` (dont le texte des messages) sont en base locale — acceptable
  mono-poste, à savoir.
- Les identifiants proxy passés en chat durant le dev doivent être révoqués
  avant usage réel (règle du cahier des charges d'origine).
- Jamais de premier contact automatique ; jamais d'initiative d'envoi sans
  conversation existante ; limites strictes §10.

---

## 14. Historique git local

```
8c0449c filtres Leboncoin intégrés — tous vérifiés en live
ff3e72e veilles : personnalisation complète + bouton lancer réactif
5fb7e4c recherche vide : jamais de fetch upstream (flux générique polluait)
9872950 purge des données de démo + repli proxy automatique sur DataDome
9fff782 anysolver armé (solde 5$), démarrage login installé, backtest complet
b198694 envoi réel testé et vérifié upstream — bug de ciblage corrigé
eb7a666 README: document de passation complet pour reprise à froid
f50eeae rafraîchissement automatique du bearer JWT
494a631 session chrome auto-import + messagerie live complète (v3 + HAL)
7b04b1c chrome devtools login + capture, routage par flux, stress test
d67045b bootstrap: monorepo, serveur local, console web, engine live wreq-js
```

L'opérateur décide ce qui est construit ; ses instructions directes passent
en priorité pendant une session.

---

## 15. Checklist « je reprends le projet » (pour le modèle suivant)

- [ ] `npm install && npm test` — 88 verts attendus.
- [ ] Lire §5 (contrats) et §6 (vérités acquises) EN ENTIER.
- [ ] `LBC_MODE=live npm run dev:server` + `GET /status` → mode live.
- [ ] Si session expirée : Système → Chrome (l'opérateur clique) → auto-import.
- [ ] Reprendre la liste §2 dans l'ordre. Chaque ajout : tests offline d'abord
      (vitest, zéro réseau), puis live via les procédures §12.
- [ ] Règle d'or du projet : **un 403 est résolu ou remonté en erreur
      structurée — jamais converti en liste vide.**

---

## 2026-09-04 — DataDome : c'était l'empreinte, pas l'IP ni le compte

### Ce qui bloquait
`WreqTransport` figeait `browser: "chrome_131"` **et** un User-Agent Chrome/131
en dur. En septembre 2026 ce profil a ~2 ans de retard : JA4 + UA suffisent.
Les 4 veilles partaient en quarantaine (`DataDome : tous les replis épuisés`)
alors que ni l'IP, ni l'absence de compte, ni l'absence de solveur n'y étaient
pour quoi que ce soit.

### La mesure (serveur, direct, sans proxy / session / solveur)
| profil | résultat |
| :-- | :-- |
| `chrome_131` (figé, l'ancien) | **4/4 → 403**, page de blocage 774 o |
| 9 profils modernes, un par requête | **9/9 → 200**, `__NEXT_DATA__` complet, 35 annonces, p50 ≈ 250 ms |

### Ce qui a changé
- **`adapters/leboncoin/fingerprint.ts`** — pool de 9 empreintes modernes
  (chrome 145-149, firefox 150/151, edge 148, safari 26.4 ; windows/macos/linux),
  tirage au sort par job avec mémoire des 3 dernières. `userAgentFor()` dérive
  l'UA du profil via `getEmulationHeaders()` : plus **jamais** d'UA en dur, un UA
  qui ne colle pas au profil TLS est précisément ce que DataDome cherche.
- **`adapters/leboncoin/pacer.ts`** — cadenceur global : toutes les requêtes
  leboncoin.fr sérialisées, espacées de `LBC_MIN_GAP_MS` (9 s) + jitter
  `LBC_GAP_JITTER_MS` (0-6 s). 4 veilles paginant en parallèle formaient des
  rafales — c'est le motif qui se lit, bien avant le volume. Le sleep par page
  de `runOnce` a disparu : l'espacement appartient au processus, pas à l'appelant.
  `bypassPacer: true` existe pour le stress test (qui mesure justement la rafale)
  et pour lui seul.
- **`live.ts`** — un 403 déclenche 3 rotations d'empreinte avant d'envisager
  AnySolver. La reprise « même signature après backoff » a été retirée : elle ne
  faisait que confirmer le blocage.
- **`live.ts`** — la recherche ne touche plus à la session. Le chemin
  « session d'abord, repli empreinte propre » est supprimé, `LiveEngineDeps` n'a
  plus `getSessionProfile`. La recherche est publique et un `luat` vieillissant
  était un handicap net.
- **`jobs/auto-responder.ts`** — `no_session` / `no_captured_contract` ne sont
  plus des pannes : log `info` une seule fois, puis silence. La veille n'en
  dépend pas.

### Vérifié en prod (2 cycles, 12:44 et 12:47 UTC)
`4/4 watches → completed`, 0 quarantaine, 0 challenge, une empreinte différente
par run, espacement 10-17 s observé. AnySolver posé en repli (solde 5,0055 $),
jamais tiré.

### Point d'usure connu
Le pool de `fingerprint.ts` vieillit au rythme des sorties Chrome — c'est
exactement ce qui a tué `chrome_131`. Le remonter (garder les 4-5 dernières
majeures) fait partie de l'entretien, sinon les 403 reviendront.

## 2026-09-04 (suite) — fraicheur des drops : le seuil de 24 h etait faux

Symptome : deux alertes RTX 3080 pour des annonces publiees 15 min et 4 h plus
tot. `FRESH_HOURS = 24` laissait alerter tout ce qui avait moins dun jour et

## 2026-09-04 (suite) — fraicheur des drops : le seuil de 24 h etait faux

Symptome : deux alertes RTX 3080 pour des annonces publiees 15 min et 4 h plus
tot. `FRESH_HOURS = 24` laissait alerter tout ce qui avait moins d'un jour et
qu'on voyait pour la premiere fois.

Deux sources de retard :
- **reprise apres coupure ou quarantaine** : au retour, tout ce qui est apparu
  pendant l'absence est « nouveau » pour nous ;
- **bump Leboncoin** : une vieille annonce remonte en tete du flux trie par
  date alors que `first_publication_date` reste ancien (c'est bien cette date
  que porte `publishedAt`, pas `index_date` — verifie).

Mesure du delai publication -> premiere detection, sur 7 jours :

```
  0-2 min    34      <- cas nominal
  3-5 min    16
  6-10 min    5
  11-20 min   2
  21-45 min   0      <- TROU
  46-120 min  5      <- rattrapage / bump
  2-24 h     28
  > 24 h     28
```

Distribution bimodale avec un trou franc a zero entre 21 et 45 min. En dessous
ce sont de vraies prises (parfois tardives quand un cycle traine), au-dessus
c'est du rattrapage. **Seuil pose a 20 min** (`FRESH_MINUTES`, surchargeable
par `LBC_FRESH_MINUTES`) : c'est la coupure que les donnees designent.

Consequence assumee : une annonce de 15 min alerte encore, parce qu'elle est
statistiquement une vraie prise et non un bump. Les 56 annonces des tranches
2-24 h et > 24 h, elles, ne declenchent plus rien.

Ce qui est ecarte pour anciennete est desormais **journalise** (`count`,
`freshMinutes`, echantillon d'ids et d'ages) et publie sur le bus
(`listing.stale_skipped`) : plus de suppression silencieuse.
