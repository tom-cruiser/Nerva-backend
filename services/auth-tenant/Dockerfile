# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:18-alpine AS builder
WORKDIR /app

# Copy workspace manifests first for layer caching
COPY package.json ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages/types/package.json       packages/types/
COPY packages/db/package.json          packages/db/
COPY packages/redis/package.json       packages/redis/
COPY packages/middleware/package.json  packages/middleware/
COPY services/auth-tenant/package.json services/auth-tenant/

RUN npm install --workspaces --include-workspace-root

# Copy all source
COPY packages/ packages/
COPY services/auth-tenant/ services/auth-tenant/

RUN npm run build --workspace=packages/types \
 && npm run build --workspace=packages/db \
 && npm run build --workspace=packages/redis \
 && npm run build --workspace=packages/middleware \
 && npm run build --workspace=services/auth-tenant

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:18-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules        ./node_modules
COPY --from=builder /app/packages/types/dist      packages/types/dist
COPY --from=builder /app/packages/db/dist         packages/db/dist
COPY --from=builder /app/packages/redis/dist      packages/redis/dist
COPY --from=builder /app/packages/middleware/dist  packages/middleware/dist
COPY --from=builder /app/services/auth-tenant/dist services/auth-tenant/dist

EXPOSE 3001
CMD ["node", "services/auth-tenant/dist/server.js"]
