# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# Copy workspace manifests first for layer caching
COPY package.json ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages/types/package.json       packages/types/
COPY packages/db/package.json          packages/db/
COPY packages/redis/package.json       packages/redis/
COPY packages/middleware/package.json  packages/middleware/
COPY packages/config/package.json      packages/config/
COPY services/auth-tenant/package.json services/auth-tenant/

# Install all dependencies across workspaces (including devDependencies needed for build)
RUN npm install --workspaces --include-workspace-root

# Copy all source files
COPY packages/ packages/
COPY services/ services/

# Pre-create internal package dist directories and compile the whole monorepo
RUN mkdir -p packages/db/dist packages/types/dist packages/redis/dist packages/middleware/dist \
 && npm run build

# Remove development dependencies to keep the final production image small
RUN npm prune --production --workspaces --include-workspace-root

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy optimized production dependencies only
COPY --from=builder /app/node_modules        ./node_modules

# Copy internal shared packages from the builder stage
COPY --from=builder /app/packages/types/dist      packages/types/dist
COPY --from=builder /app/packages/db/dist         packages/db/dist
COPY --from=builder /app/packages/redis/dist      packages/redis/dist
COPY --from=builder /app/packages/middleware/dist  packages/middleware/dist

# Pull the compiled build out of the builder stage
COPY --from=builder /app/services/auth-tenant/dist services/auth-tenant/dist

EXPOSE 3001
CMD ["node", "services/auth-tenant/dist/server.js"]