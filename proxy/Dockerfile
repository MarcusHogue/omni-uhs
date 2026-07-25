# syntax=docker/dockerfile:1.7

# --- build -----------------------------------------------------------------
# Debian-based, matching the distroless runtime's glibc. better-sqlite3 is a
# native module: an Alpine (musl) build would load here and then crash, so the
# builder and the runtime must agree on the libc.
FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY web/package.json web/
COPY proxy/package.json proxy/
# Optional, unset in a normal build: see web/Dockerfile for why it exists.
RUN --mount=type=cache,target=/root/.npm,id=npm-proxy,sharing=locked \
    --mount=type=secret,id=proxy_ca,target=/tmp/proxy-ca.crt \
    sh -eu -c 'if [ -s /tmp/proxy-ca.crt ]; then \
        npm config set cafile /tmp/proxy-ca.crt; \
      fi; \
      npm ci --workspace proxy --include-workspace-root'

COPY tsconfig.base.json ./
COPY proxy/ proxy/
RUN npm run build --workspace proxy

# The cache directory has to exist in the image and be owned by the runtime
# user: Docker seeds an empty named volume from the image path, ownership
# included, and distroless has no shell to chown it at startup.
RUN mkdir -p /seed/cache

# Reinstall production dependencies only, hoisted into the proxy's own tree so
# the runtime image needs nothing from the workspace root.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY proxy/package.json ./package.json
RUN --mount=type=cache,target=/root/.npm,id=npm-proxy-deps,sharing=locked \
    --mount=type=secret,id=proxy_ca,target=/tmp/proxy-ca.crt \
    sh -eu -c 'if [ -s /tmp/proxy-ca.crt ]; then \
        npm config set cafile /tmp/proxy-ca.crt; \
      fi; \
      npm install --omit=dev --no-package-lock'

# --- runtime ---------------------------------------------------------------
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/proxy/dist ./dist
COPY --from=build /app/proxy/package.json ./package.json
COPY --from=build --chown=nonroot:nonroot /seed/cache /data/cache

ENV NODE_ENV=production \
    PORT=8080 \
    CACHE_DIR=/data/cache

# distroless has no shell, so the health check is an exec-form node one-liner.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

EXPOSE 8080
CMD ["dist/server.js"]
