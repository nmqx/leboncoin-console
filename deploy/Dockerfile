# Console Leboncoin — image unique : build du front Vite + serveur Fastify.
# Le serveur sert apps/web/dist sur le même port (voir server.ts).
#
# L'image embarque aussi un Chrome réel + un bureau X virtuel exposé en noVNC :
# la connexion au compte Leboncoin passe par le flux « Ouvrir Chrome & se
# connecter » de la console, donc depuis l'IP de cette machine — c'est ce
# couple IP + User-Agent que DataDome vérifiera ensuite sur chaque requête.
FROM node:24-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      xvfb x11vnc openbox \
      novnc websockify \
      ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Chromium refuse le bac à sable dans un conteneur : on l'enveloppe plutôt que
# de toucher au code, qui respecte CHROME_PATH.
RUN printf '#!/bin/sh\nexec /usr/bin/chromium --no-sandbox --disable-dev-shm-usage --disable-gpu "$@"\n' \
      > /usr/local/bin/chromium-headful \
    && chmod +x /usr/local/bin/chromium-headful

# Dépendances d'abord : le cache de couche survit aux modifications de code.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/fixtures/package.json packages/fixtures/package.json
# npm ci complet : vite/rollup/esbuild dependent de paquets optionnels par
# plateforme (les omettre casse le build du front). @primno/dpapi est un module
# natif Windows, inerte ici : le coffre bascule sur AES local hors win32.
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build -w apps/web

COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV HOST=0.0.0.0 \
    PORT=8787 \
    NODE_ENV=production \
    DISPLAY=:99 \
    SCREEN_GEOMETRY=1600x900x24 \
    CHROME_PATH=/usr/local/bin/chromium-headful
EXPOSE 8787 6080

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["npm", "run", "start", "-w", "apps/server"]
