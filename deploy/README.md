# Déploiement Docker

La console Leboncoin tourne sur Docker Engine et conserve ses données dans un
dossier de l'hôte. Elle ne dépend donc ni de Docker Desktop, ni de sa VM, ni
d'un volume opaque. Caddy publie l'application et noVNC sur une seule adresse.

## Démarrer

```bash
cp deploy/.env.example deploy/.env
# Renseigner LBC_BIND_IP avec l'adresse Tailscale du serveur.
docker --context default compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build
```

En production, l'interface est disponible sur
`http://<adresse-tailscale>:8899/`. Il n'y a pas de mot de passe HTTP ; le port
doit donc rester lié à l'adresse Tailscale et ne doit pas être publié sur
`0.0.0.0`.

Le profil Chrome vit dans `LBC_DATA_DIR/chrome-profile`. La base, la clé du
coffre et la session survivent aux reconstructions de l'image et restent
sauvegardables avec les outils ordinaires de l'hôte.

## Démarrage automatique

Les unités de `deploy/systemd/` lancent la stack avec Docker Engine au
démarrage et vérifient l'URL locale toutes les deux minutes. Après trois échecs
consécutifs, le watchdog recrée uniquement les deux conteneurs Leboncoin.

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/lbc-console.service deploy/systemd/lbc-watchdog.service deploy/systemd/lbc-watchdog.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now lbc-console.service lbc-watchdog.timer
```

## Connexion Leboncoin depuis une machine sans écran

1. Console → Système → « Ouvrir Chrome & se connecter ».
2. Ouvrir `/vnc` sur la même adresse.
3. Se connecter à Leboncoin dans ce Chrome.
4. Parcourir la messagerie si ses contrats doivent être capturés.
5. Console → « Terminer & importer ».

`LBC_MODE=live` active le vrai moteur. Le filtre LLM exige la clé chiffrée dans
la console et `LLM_BASE_URL` dans `deploy/.env`.
