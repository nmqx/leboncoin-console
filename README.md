# Leboncoin Console

Surveillance locale de Leboncoin pour chineur : recherche en direct, veilles cadencees, messagerie reelle et detection de bonnes affaires. Console web sombre et dense, clavier d abord, en francais.

## A quoi ca sert

| Module | Utilite | Detail |
| --- | --- | --- |
| Recherche | Trouver maintenant | Scraping site public via empreinte TLS Chrome avec wreq, pagination multi pages, tous les filtres Leboncoin prix, vendeur, categorie, livrable, urgent, attributs. Tri recent corrige par published_at. |
| Veilles | Ne rien rater | Cadence par veille avec jitter, seuil top pourcentage affaire, resultats isoles par veille, webhook par veille configurable. |
| Anti faux positifs | Eviter le bruit | Filtre deterministe a 1 euro et echange/troc/don plus filtre semantique LLM groupe par run. Badge achat en cours detecte et affiche. |
| Messagerie | Repondre sans friction | Inbox, fils, envoi. Connexion par capture DevTools : tu te connectes dans Chrome, la console importe les tokens. |
| Prix | Payer le juste prix | Historique par annonce, comparaison 2 a 4 annonces, score bonne affaire sur mediane de categorie. |
| Stockage | Rester local | SQLite sous data, secrets chiffres DPAPI lies a ta session Windows, rien ne sort sauf vers leboncoin.fr et tes webhooks. |

## Vues

| Vue | Raccourci | Role |
| --- | --- | --- |
| Recherche | 1 | Barre en deux rangs, filtres prix et categorie, sources Leboncoin direct ou veille, tri Plus recents par defaut |
| Veilles | 2 | Liste des recherches sauvegardees, frequence, dernier run, assignation webhooks par veille, run manuel |
| Resultats | 3 | Annonces d une veille, rafraichissement 30s, tri prix ou date |
| Messagerie | 4 | Conversations, classification, contexte annonce, brouillon LLM, automation on ou off |
| Webhooks | 5 | Discord et HTTP HMAC, livraisons avec backoff 1 min, 5 min, 30 min, 2 h puis dead letter |
| Systeme | 6 | Session, proxy avec test sticky, AnySolver, LLM, routage, automation et kill switch |

## Demarrage

```powershell
npm install
npm run dev                                  # mode demo avec fixtures, zero reseau
$LBC_MODE="live"; npm run dev:server         # mode live avec vraies annonces
```

Console : http://localhost:5173 en dev ou http://127.0.0.1:8787 en build.

Premiere fois en live : rien a faire, les veilles tournent sans compte (recherche publique, empreinte TLS tournante). La connexion Chrome n est utile QUE pour la messagerie : Systeme puis Ouvrir Chrome et se connecter, l import est automatique et la session se rafraichit seule. Les reglages mode, base, gateway LLM persistent dans console.config.json qui est ignore par git.

Optionnel : cle LLM dans Systeme puis LLM pour activer filtre semantique et brouillons. Le proxy n est plus utile a la recherche (direct, 0 Mo) et AnySolver n est qu un repli jamais atteint en pratique.

## Webhooks par veille

Chaque webhook peut etre global ou assigne a une ou plusieurs veilles.

| Configuration | Comportement |
| --- | --- |
| Aucune veille assignee | Webhook global : recoit tous les evenements pour lesquels il est abonne |
| Une ou plusieurs veilles assignees | Webhook filtre : recoit uniquement watch.completed et challenge.failed de ces veilles |
| Table watch_webhooks | Liaison N vers N, creee en migration 4, exposee via PUT /watches/:id/webhooks |

Assignation dans Veilles : ouvre la veille, coche les webhooks dans la section Webhooks assignes. Ou via API : `PUT /api/v1/watches/:id/webhooks { webhookIds: [1,2] }`.

Evenements disponibles : `listing.created`, `listing.price_changed`, `watch.completed`, `challenge.failed`, `message.received`, `reply.sent`, `reply.failed`, `session.expiring`.

## MCP pour agents IA

Serveur MCP local en stdio, zero dependance, expose la base locale aux agents.

```powershell
npm run mcp
```

Config exemple pour Claude Desktop ou VS Code :

```json
{
  "mcpServers": {
    "lbc-console": {
      "command": "npx",
      "args": ["tsx", "apps/server/src/mcp/index.ts"],
      "cwd": "C:/chemin/vers/leboncoin-console"
    }
  }
}
```

| Outil | Description | Entree principale |
| --- | --- | --- |
| search_listings | Recherche en base locale | query, priceMin, priceMax, ownerType, category, limit |
| get_listing | Detail annonce avec historique prix | id |
| compare_listings | Compare 2 a 4 annonces | ids |
| list_watches | Liste les veilles avec webhooks assignes |  |
| get_watch | Detail veille | id |
| create_watch | Cree une veille | name, query, priceMin, priceMax, cadenceMinutes, webhookIds |
| delete_watch | Supprime une veille | id |
| list_watch_results | Resultats d une veille | watchId, limit |
| list_new_listings | Dernieres annonces decouvertes | limit |
| list_conversations | Conversations locales |  |
| get_conversation | Conversation avec messages | id |
| list_webhooks | Webhooks configures |  |
| set_watch_webhooks | Assigne webhooks a une veille | watchId, webhookIds |
| list_jobs | Derniers jobs | limit |
| system_status | Compteurs et etat |  |

Badge achat en cours : detecte via status et attributs Leboncoin contenant achat en cours, reserve ou vendu et expose en `attributes._achatEnCours`. Affiche dans Recherche, Resultats et Detail.

## Tests

```powershell
npm test                # 99 tests offline
npx playwright test     # 7 e2e avec serveur requis
npm run typecheck       # strict, server et web
```

## Docs

| Fichier | Contenu |
| --- | --- |
| HANDOFF.md | Passation complete pour reprendre a froid, contrats API reverses, pieges serveur, architecture, statut |
| SETUP.md | Installer et reprendre le dev sur une autre machine |
| DESIGN.md | Tokens OKLCH, densite, mouvement |
| PRODUCT.md | Registre product, principes, anti references |

## Avertissement

Outil personnel de veille sur des annonces publiques. Respecte les conditions du site. Ton compte est le tien. Le routage par defaut garde la messagerie en direct sur ton IP residentielle pour cette raison.
