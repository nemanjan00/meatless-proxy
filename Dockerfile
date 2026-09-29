# syntax=docker/dockerfile:1
# meatless-proxy: one image with the API, web UI, WebSocket, MCP server and workers.

# ── Build: install dependencies and build the web UI ─────────────────────────
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN npm ci --no-audit --no-fund
# Build the web UI when it has a build script; the server serves packages/web/dist.
RUN if node -e "process.exit(require('./packages/web/package.json').scripts?.build ? 0 : 1)"; then \
      npm run build -w @mp/web; \
    else \
      echo "no web build script, skipping the UI"; \
    fi

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:26-slim AS runtime
# Versions come from the pinned base image's Debian release; pinning each package would break on every point release.
# hadolint ignore=DL3008
RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app
# The server runs from TypeScript source with tsx (a dev dependency), so node_modules is kept as installed.
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY docker/app-entrypoint.sh /usr/local/bin/app-entrypoint.sh
RUN mkdir -p /data /var/lib/meatless-proxy/files && chown 1000:1000 /data /var/lib/meatless-proxy/files
# The container starts as root only long enough for the entrypoint to give the
# `node` user (1000:1000) the Docker socket's group, whose gid differs per host;
# the app itself always runs as `node`.
# hadolint ignore=DL3002
USER root
EXPOSE 3000 3001
VOLUME ["/data"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/app-entrypoint.sh"]
CMD ["node", "--import", "tsx", "packages/server/src/main.ts"]
