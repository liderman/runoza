ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NODE_OPTIONS=--dns-result-order=ipv4first npm_config_fetch_timeout=30000 npm_config_fetch_retries=1
RUN npm install --global npm@11.6.2 --ignore-scripts --no-audit --no-fund
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
ARG NPM_OFFLINE=false
RUN --mount=type=cache,id=runoza-npm,target=/root/.npm npm ci --offline=${NPM_OFFLINE} --ignore-scripts --no-audit --no-fund && npm run build:server && rm -rf node_modules && npm ci --offline=${NPM_OFFLINE} --omit=dev --workspace @runoza/server --workspace @runoza/worker --workspace @runoza/migrate --include-workspace-root=false --ignore-scripts --no-audit --no-fund && node --input-type=module -e 'await import("./packages/providers/dist/index.js"); await import("./packages/execution/dist/index.js")'
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/server ./apps/server
COPY --from=build --chown=node:node /app/apps/worker ./apps/worker
COPY --from=build --chown=node:node /app/apps/migrate ./apps/migrate
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --chown=node:node LICENSE ./LICENSE
USER node
EXPOSE 3000
CMD ["node","apps/server/dist/main.js"]
