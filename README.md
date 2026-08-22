# Leboncoin Console

Surveillance locale de Leboncoin pour chineur : recherche en direct, veilles
cadencées, messagerie réelle, et détection de bonnes affaires — le tout dans
une console web sombre et dense, clavier d'abord, en français.

## Ce que ça fait

- **Recherche en direct** — scraping du site public (empreinte TLS Chrome via
  wreq), pagination multi-pages, tous les filtres Leboncoin (prix, vendeur,
  catégorie, livrable, urgent, attributs…).
- **Veilles cadencées** — cadence et seuil « top % affaire » par veille,
  résultats isolés par veille, notifications Discord / webhook signé HMAC.
- **Anti-faux positifs** — filtre déterministe (≤ 1 €, échange/troc/don) +
  filtre sémantique LLM par défaut : une coque n'est pas un téléphone,
  « Just Dance » n'est pas une console Switch, un Pixel 8a n'est pas un 8.
- **Messagerie réelle** — inbox, fils, envoi. Connexion par capture DevTools :
  tu te connectes dans Chrome, la console importe les tokens, c'est tout.
- **Historique de prix** — chaque changement est suivi, comparaison entre
  annonces, score bonne affaire sur médiane de catégorie.
- **100 % local** — SQLite sous `data/`, secrets chiffrés DPAPI (liés à ta
  session Windows), rien ne sort de la machine sauf vers leboncoin.fr et les
  webhooks que tu configures.

## Démarrage

```powershell
npm install
npm run dev                                  # mode démo (fixtures, zéro réseau)
$LBC_MODE="live"; npm run dev:server         # mode live (vraies annonces)
```

Console : http://localhost:5173 (dev) ou http://127.0.0.1:8787 (build).

Première fois en live : **Système → « Ouvrir Chrome & se connecter »** —
connecte-toi, l'import est automatique, aucun message à envoyer. La session
se rafraîchit toute seule ; les réglages (mode, base, gateway LLM)
persistent dans `console.config.json` (gitignored).

Optionnel : clé LLM dans Système → LLM (active le filtre sémantique et les
brouillons de réponse), proxy pour la recherche, AnySolver si DataDome
s'énerve (jamais requis à ce jour).

## Tests

```powershell
npm test                # 99 tests offline
npx playwright test     # 7 e2e (serveur lancé requis)
npm run typecheck       # strict, server + web
```

## Docs

- **[HANDOFF.md](HANDOFF.md)** — passation complète pour reprendre le projet
  à froid (contrats API reversés, pièges serveur, architecture, statut).
- **[SETUP.md](SETUP.md)** — installer et reprendre le dev sur une autre machine.

## Avertissement

Outil personnel de veille sur des annonces publiques. Respecte les conditions
du site, ton compte est le tien — le routage par défaut garde la messagerie
en direct sur ton IP résidentielle pour cette raison.
