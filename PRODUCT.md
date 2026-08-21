# PRODUCT.md — Console locale Leboncoin

## Registre `product`

Une console de poste de pilotage. Pas un site, pas un SaaS, pas une vitrine.
Un outil d'opérateur qui surveille, compare, décide et répond — installé sur le PC
de l'opérateur, lié à `127.0.0.1`, sans compte, sans cloud, sans télémétrie.

## Utilisateur

Opérateur unique. Il surveille des annonces (neuves, baisse de prix, bonnes
affaires), gère des veilles récurrentes, lit sa messagerie Leboncoin et laisse
l'assistant répondre automatiquement selon des règles strictes et des limites
budgétaires. Il est technicien : il veut des densités élevées, du clavier, des
données brutes visibles et des erreurs explicites — jamais de liste vide
silencieuse.

## Personnalité

Précise, tactique, calme. La console parle peu et juste. Chaque chiffre est
traçable jusqu'à sa source. Chaque échec est nommé (`403`, challenge, quarantaine)
avec une action possible.

## Anti-références

- SaaS générique et ses cartes imbriquées
- Glassmorphism, flous, néons cyberpunk
- Copie visuelle de Leboncoin (orange, arrondis, marketing)
- Dashboard marketing avec gros chiffres décoratifs
- Messages vides du type « tout va bien »

## Principes

1. **Densité d'information** : rangées de 34–40 px, colonnes alignées, pas d'air décoratif.
2. **Clavier prioritaire** : chaque action a un raccourci (`1–6` vues, `/` recherche, `j/k` navigation, `Entrée` détail, `Échap` fermer, `?` aide).
3. **Aucun 403 non traité** : un `403` initial peut être le mécanisme DataDome normal ; il est résolu (challenge) ou remonté comme erreur structurée — jamais converti en résultat vide.
4. **Traçabilité** : chaque liste affiche sa source (`authorized-api`, `authorized-web`, `import`, `fixtures`), chaque job son `correlationId`, chaque livraison webhook sa signature.
5. **Secrets** : DPAPI CurrentUser uniquement. Jamais en clair dans SQLite, le frontend, Git ou les logs.
6. **Français** : interface, dates et prix en `fr-FR` / `Europe/Paris`.

## Événements produits

`listing.created`, `listing.price_changed`, `watch.completed`, `message.received`,
`reply.sent`, `reply.failed`, `challenge.failed`, `session.expiring`.

## Limites assumées

- Mono-utilisateur, mono-machine, service local au login.
- Cadence 10 minutes + jitter — pas de rafale.
- Budget AnySolver par jour et plafond monétaire configurables.
- Le transport LLM en HTTP public est un risque accepté par l'opérateur, rappelé en permanence dans l'interface.
