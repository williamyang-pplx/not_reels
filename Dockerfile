# syntax = docker/dockerfile:1
ARG NODE_VERSION=22.22.2
FROM node:${NODE_VERSION}-slim AS base
WORKDIR /app
ENV NODE_ENV=production
# The optional npmrc secret lets local builds use a private registry mirror; Fly's builder doesn't need it.
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false npm install -g pnpm@9.15.9

# Build: install everything, bundle server + client, then drop dev dependencies.
FROM base AS build
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential python3 && \
    rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false pnpm install --frozen-lockfile --prod=false
COPY . .
# The server is one bundle; at runtime it only needs the native addons: better-sqlite3, and sharp (image shrinking)
# with this machine's Linux binary (@img/sharp-linux-<arch> + libvips) and its JS deps.
RUN pnpm run build && \
    mkdir -p /out/node_modules && \
    cp -RL node_modules/better-sqlite3 /out/node_modules/ && \
    cp -RL node_modules/sharp /out/node_modules/ && \
    mkdir -p /out/node_modules/@img && \
    arch=$(node -p process.arch) && \
    for p in @img/colour "@img/sharp-linux-$arch" "@img/sharp-libvips-linux-$arch" detect-libc semver; do \
      cp -RL "node_modules/.pnpm/node_modules/$p" "/out/node_modules/$p"; \
    done && \
    rm -rf /out/node_modules/better-sqlite3/deps /out/node_modules/better-sqlite3/src

# Runtime: the bundled server, the native addons, static files and the RYM data.
FROM node:${NODE_VERSION}-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist /app/dist
COPY --from=build /out/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package.json
COPY public /app/public
COPY data /app/data
# Redlib (Reddit posts and the post sheet): one static binary, started on loopback by fly-start.sh.
COPY --from=ghcr.io/nachtalb/redlib:latest /usr/local/bin/redlib /usr/local/bin/redlib
COPY scripts/fly-start.sh /app/fly-start.sh
RUN mkdir -p /data
VOLUME /data
ENV DATABASE_URL="file:///data/sqlite.db"
EXPOSE 3000
# Migrations run in-process at boot (idempotent CREATE TABLE IF NOT EXISTS).
CMD ["/app/fly-start.sh"]
