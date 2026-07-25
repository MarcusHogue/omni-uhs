# syntax=docker/dockerfile:1.7

# --- build -----------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Copy manifests first so the dependency layer survives source edits.
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY proxy/package.json proxy/
# The `proxy_ca` secret is optional and unset in a normal build. Supply it only
# when building behind a TLS-intercepting egress proxy, whose CA npm has to
# trust:
#   docker build --network=host --secret id=proxy_ca,src=/path/ca-bundle.crt .
RUN --mount=type=cache,target=/root/.npm,id=npm-web,sharing=locked \
    --mount=type=secret,id=proxy_ca,target=/tmp/proxy-ca.crt \
    sh -eu -c 'if [ -s /tmp/proxy-ca.crt ]; then \
        npm config set cafile /tmp/proxy-ca.crt; \
      fi; \
      npm ci --workspace web --include-workspace-root'

COPY tsconfig.base.json ./
COPY web/ web/

# Stamped into the bundle so the app can name its own build and notice when the
# browser and the proxy are running different ones. Defaults to `dev` for a
# plain local build, which switches the version UI off.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
RUN npm run build --workspace web

# --- runtime ---------------------------------------------------------------
FROM caddy:2-alpine AS runtime

COPY web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/web/dist /srv

# Caddy validates the config at startup, but catching a syntax error at build
# time is cheaper than catching it at deploy time.
RUN caddy validate --config /etc/caddy/Caddyfile

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --quiet --spider http://127.0.0.1:80/healthz || exit 1

EXPOSE 80
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
