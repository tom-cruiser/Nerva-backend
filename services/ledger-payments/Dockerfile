FROM node:18-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.base.json tsconfig.json ./
COPY packages/types/package.json            packages/types/
COPY packages/db/package.json               packages/db/
COPY packages/redis/package.json            packages/redis/
COPY packages/middleware/package.json       packages/middleware/
COPY services/ledger-payments/package.json  services/ledger-payments/
RUN npm install --workspaces --include-workspace-root
COPY packages/ packages/
COPY services/ledger-payments/ services/ledger-payments/
RUN npm run build --workspace=packages/types \
 && npm run build --workspace=packages/db \
 && npm run build --workspace=packages/redis \
 && npm run build --workspace=packages/middleware \
 && npm run build --workspace=services/ledger-payments

FROM node:18-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules                  ./node_modules
COPY --from=builder /app/packages/types/dist           packages/types/dist
COPY --from=builder /app/packages/db/dist              packages/db/dist
COPY --from=builder /app/packages/redis/dist           packages/redis/dist
COPY --from=builder /app/packages/middleware/dist       packages/middleware/dist
COPY --from=builder /app/services/ledger-payments/dist services/ledger-payments/dist
EXPOSE 3004
CMD ["node", "services/ledger-payments/dist/server.js"]
