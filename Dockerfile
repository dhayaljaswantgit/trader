# AI Trader — single container: API + built web UI on one port (4000). PAPER-only.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini && rm -rf /var/lib/apt/lists/*
# Claude Code CLI for 💬 Market Chat (provider "Local Claude Code"); log in once: docker exec -it <container> claude
RUN corepack enable && npm install -g @anthropic-ai/claude-code
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter web build \
 && cd apps/api && pnpm exec prisma generate
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=4000 DATA_DIR=/app/data HOME=/app/data/home TZ=Asia/Kolkata
VOLUME ["/app/data"]
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "mkdir -p /app/data/home && cd apps/api && pnpm exec prisma migrate deploy && exec pnpm exec tsx src/server.ts"]
