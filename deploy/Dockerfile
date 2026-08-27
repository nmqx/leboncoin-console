# Console Leboncoin — image unique : build du front Vite + serveur Fastify.
# Le serveur sert apps/web/dist sur le même port (voir server.ts).
FROM node:24-bookworm-slim

WORKDIR /app

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

ENV HOST=0.0.0.0 \
    PORT=8787 \
    NODE_ENV=production
EXPOSE 8787

CMD ["npm", "run", "start", "-w", "apps/server"]
