# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS builder
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json biome.json vitest.config.ts ./
COPY apps ./apps
COPY packages ./packages
COPY prompts ./prompts
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm deploy --legacy --filter @sent/server --prod /output/server
RUN pnpm deploy --legacy --filter @sent/worker --prod /output/worker

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST_PATH=/app/web \
    MIGRATIONS_PATH=/app/migrations
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=builder /output/server ./server
COPY --from=builder /output/worker ./worker
COPY --from=builder /workspace/apps/web/dist ./web
COPY --from=builder /workspace/packages/core/src/db/migrations ./migrations
COPY --from=builder /workspace/prompts ./prompts
USER node
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
