# Diagnostic Leboncoin du 12 septembre 2026

## Constats

- Le serveur `100.108.107.52` n'est pas joignable depuis ce PC : Tailscale est en `NoState`, déconnecté, avec une erreur IPv6 vers son serveur de coordination. SSH et le port 8899 expirent. L'état actuel de l'IP publique du serveur n'est donc pas vérifié.
- Une seule requête finder/search depuis ce PC à 13:51:10 UTC renvoie HTTP 403, challenge `t=fe`, profil Chrome 149 / Windows. Ce résultat ne prouve ni un blocage `t=bv`, ni l'état de l'IP du serveur.
- Le rollback avait réintroduit trois reprises TLS immédiates après un 403, un repli proxy implicite, la lecture du solveur payant sans vérifier son opt-in, et le lancement de plusieurs veilles successives.
- Dans une précédente version, LiveEngine conservait son profil dans un champ : modifier le pool ne garantissait donc pas la rotation entre cycles. La version présente crée un transport par cycle. Un test du moteur vérifie deux profils différents pour deux cycles.

## Correctif

- Recherche par HTTP avec wreq, sans navigateur automatisé.
- Neuf profils existants, UA et en-têtes fournis par le même profil TLS/HTTP2. Pas d'augmentation du pool sans validation réelle.
- Un départ de veille global toutes les cinq minutes ; quatre veilles repassent chacune environ toutes les vingt minutes. Le tick de 15 secondes peut décaler légèrement l'heure réelle.
- Sur DataDome : une seule requête échouée, reprise au prochain cycle, backoff constant de cinq minutes. Pas de cascade de retries ni de proxy implicite. Les autres pannes conservent leur backoff propre.
- Échéance conservée en SQLite pour qu'un redémarrage ne contourne pas le délai. Pause sans nouveaux jobs et échéance affichée correctement après reprise.
- Solveur payant désactivé sauf `LBC_ALLOW_PAID_SOLVER=1` explicite.
- Alertes de panne partagée après trois échecs, déduplication six heures dans le processus.

## Validation et reprise

108 tests passent, typecheck et build passent. Tests de comportement : un seul appel par blocage, rotation effective entre deux cycles, solveur non consulté sans opt-in, intervalle conservé après redémarrage, aucun job créé sous kill switch.

Diagnostic isolé, à exécuter depuis la machine dont on veut tester l'accès :

```sh
node --import tsx scripts/probe-lbc.mts "rtx 3090"
```

Cette commande fait une seule requête, sans base, compte, webhook, solveur ou rejeu. Elle affiche le statut et les compteurs, sans corps de challenge ni données d'annonces. Éviter de la lancer en parallèle de la veille.

Le déploiement et la validation en production restent à faire une fois Tailscale reconnecté : pull, build Docker dans le contexte `default`, sonde isolée pendant la pause, puis reprise de la veille seulement après examen du résultat. Un passage des tests locaux ne signifie pas que Leboncoin accepte l'IP de production.
