# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json tsconfig.base.json tsconfig.json ./
COPY packages/types/package.json             packages/types/
COPY packages/db/package.json                packages/db/
COPY packages/redis/package.json             packages/redis/
COPY packages/middleware/package.json        packages/middleware/
COPY packages/config/package.json            packages/config/
COPY services/whatsapp-engine/package.json   services/whatsapp-engine/

RUN npm install --workspaces --include-workspace-root

COPY packages/ packages/
COPY services/ services/

RUN mkdir -p packages/db/dist packages/types/dist packages/redis/dist packages/middleware/dist \
 && npm run build

RUN npm prune --production --workspaces --include-workspace-root

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
# Switch to slim (Debian-based) to support Chromium dependencies
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Install Chromium and necessary system libraries for Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    libnss3 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxshmfence1 \
    libgbm1 \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the installed Chromium binary instead of downloading its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Copy optimized production dependencies only
COPY --from=builder /app/node_modules                   ./node_modules
COPY --from=builder /app/packages/types/dist            packages/types/dist
COPY --from=builder /app/packages/db/dist               packages/db/dist
COPY --from=builder /app/packages/redis/dist            packages/redis/dist
COPY --from=builder /app/packages/middleware/dist       packages/middleware/dist
COPY --from=builder /app/services/whatsapp-engine/dist  services/whatsapp-engine/dist

EXPOSE 3005
CMD ["node", "services/whatsapp-engine/dist/server.js"]