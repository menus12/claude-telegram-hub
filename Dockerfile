# syntax=docker/dockerfile:1

# ── build: install all deps + compile the workspace ──────────────────────────
FROM node:20-slim AS build
WORKDIR /app
# Dependency manifests first, for a cacheable install layer.
COPY package.json package-lock.json tsconfig.base.json tsconfig.build.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/channel/package.json packages/channel/
COPY packages/hub/package.json packages/hub/
RUN npm ci
COPY . .
RUN npm run build

# ── runtime: production deps + compiled output only ──────────────────────────
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only (no typescript/eslint/vitest).
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/channel/package.json packages/channel/
COPY packages/hub/package.json packages/hub/
RUN npm ci --omit=dev --ignore-scripts

# Compiled JS for the hub and its workspace dependency.
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/packages/hub/dist packages/hub/dist

# One image, many deployments: only the environment differs. Bind all interfaces
# so the container is reachable; front it with auth/TLS in production.
ENV HUB_BIND_HOST=0.0.0.0 \
    HUB_BIND_PORT=8787
EXPOSE 8787

# Drop privileges — the base image ships an unprivileged `node` user.
USER node

# Liveness via the hub's own /healthz (no extra tooling needed; Node has fetch).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.HUB_BIND_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "packages/hub/dist/main.js"]
