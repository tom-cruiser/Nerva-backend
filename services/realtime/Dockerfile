# ====================================================================
# STAGE 1: Base image for caching dependencies
# ====================================================================
FROM node:20-alpine AS base
WORKDIR /app

# Copy root configurations
COPY package.json package-lock.json* tsconfig.base.json tsconfig.json ./

# Copy package.json structures for workspaces
COPY packages/types/package.json ./packages/types/
COPY packages/db/package.json ./packages/db/
COPY packages/redis/package.json ./packages/redis/
COPY packages/supabase-admin/package.json ./packages/supabase-admin/
COPY packages/middleware/package.json ./packages/middleware/
COPY packages/config/package.json ./packages/config/
COPY services/realtime/package.json ./services/realtime/

# ====================================================================
# STAGE 2: Install dependencies and compile TypeScript
# ====================================================================
FROM base AS builder
# Install ALL dependencies
RUN npm clean-install --workspaces --include-workspace-root

# Copy the rest of the source code
COPY packages/ ./packages/
COPY services/ ./services/

# Build realtime and its dependencies
RUN npx tsc --build services/realtime --force

# ====================================================================
# STAGE 3: Final runtime image with production dependencies
# ====================================================================
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 1. First, recreate the workspace folder structure in runtime
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages/types/package.json ./packages/types/package.json
COPY --from=builder /app/packages/db/package.json ./packages/db/package.json
COPY --from=builder /app/packages/redis/package.json ./packages/redis/package.json
COPY --from=builder /app/packages/supabase-admin/package.json ./packages/supabase-admin/package.json
COPY --from=builder /app/packages/middleware/package.json ./packages/middleware/package.json
COPY --from=builder /app/packages/config/package.json ./packages/config/package.json
COPY --from=builder /app/services/realtime/package.json ./services/realtime/package.json

# 2. Copy node_modules from builder and prune dev dependencies
COPY --from=builder /app/node_modules ./node_modules
RUN npm prune --omit=dev --workspaces --include-workspace-root

# 3. Copy compiled files
COPY --from=builder /app/packages/types/dist ./packages/types/dist
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/redis/dist ./packages/redis/dist
COPY --from=builder /app/packages/supabase-admin/dist ./packages/supabase-admin/dist
COPY --from=builder /app/packages/middleware/dist ./packages/middleware/dist
COPY --from=builder /app/services/realtime/dist ./services/realtime/dist

# 4. Copy compiled config files
COPY --from=builder /app/packages/config/dist ./packages/config/dist

EXPOSE 3008

CMD ["node", "services/realtime/dist/server.js"]
