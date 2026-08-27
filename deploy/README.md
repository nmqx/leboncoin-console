# Déploiement Docker

Console complète (serveur Fastify + front construit) derrière Caddy, protégée
par un mot de passe HTTP Basic. L'image embarque aussi un Chrome réel sur un
bureau X virtuel, accessible en noVNC : c'est ce qui permet de connecter le
compte Leboncoin depuis une machine sans écran.

## Démarrer

```bash
cp deploy/.env.example deploy/.env
# hash bcrypt du mot de passe
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'mon-mot-de-passe'
# coller le hash dans LBC_HASH, en doublant chaque $ ($$) : docker compose
# interpole les valeurs du .env, un $ simple serait mangé
cd deploy && docker compose up -d
```

Accès :

| Depuis | URL |
| --- | --- |
| LAN / tailnet | `http://<ip-machine>:8080` |
| Web public, URL stable | `tailscale funnel --bg 8080` puis `https://<machine>.<tailnet>.ts.net` |
| Web public, sans compte | `docker compose --profile public up -d` puis l'URL `*.trycloudflare.com` des logs `lbc-tunnel` |

Le Funnel demande une activation unique du tailnet (le CLI imprime le lien).
Le profil `public` est un tunnel Cloudflare éphémère : l'URL change à chaque
redémarrage du conteneur.

## Connecter le compte Leboncoin depuis une machine sans écran

Le modèle de session actuel de Leboncoin est un bearer JWT capté par le flux
DevTools, pas un simple cookie recopiable. Et DataDome lie la session au
couple IP + User-Agent : une session ouverte sur un autre poste, rejouée
depuis cette machine, se fait challenger. Il faut donc se connecter **depuis
cette machine**, ce que permet le bureau distant.

1. Console → Système → « Ouvrir Chrome & se connecter ».
2. Ouvrir `/vnc` (même mot de passe) : le Chrome lancé s'y affiche.
3. Se connecter à Leboncoin dans ce Chrome. L'import est automatique.
4. Parcourir la messagerie (inbox + un envoi) pour capturer les contrats.
5. Console → « Terminer & importer ».

Le profil Chrome vit dans le volume `lbc-data` (`/app/data/chrome-profile`) :
la connexion survit aux redémarrages du conteneur.

## Notes

- Le coffre bascule sur AES local hors Windows (clé `data/.vault-key` dans le
  volume). Perdre le volume, c'est perdre session et clés.
- `LBC_MODE=live` par défaut ici. Mettre `fixtures` pour un mode hors-ligne.
- Le filtre LLM exige **deux** choses : la clé (écran Système, chiffrée dans le
  coffre) et `LLM_BASE_URL` dans `deploy/.env`. Sans l'URL de la gateway, la
  clé seule laisse l'écran Système en échec (`console.config.json` reste à la
  racine du repo hôte, il n'entre pas dans l'image). Vérification :
  `POST /api/v1/diagnostics/llm` doit répondre `{"ok":true,...,"sample":"pong"}`.
- Rien n'est joignable sans le mot de passe : Caddy est le seul port publié,
  l'application et le VNC ne sont exposés que sur le réseau Docker interne.
