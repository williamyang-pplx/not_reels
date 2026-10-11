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
RUN pnpm run build && pnpm prune --prod

# Runtime: the bundled server, the native sqlite addon, static files and the RYM data.
FROM node:${NODE_VERSION}-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist /app/dist
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package.json
COPY public /app/public
COPY data /app/data
RUN mkdir -p /data
VOLUME /data
ENV DATABASE_URL="file:///data/sqlite.db"
EXPOSE 3000
# Migrations run in-process at boot (idempotent CREATE TABLE IF NOT EXISTS).
CMD ["node", "dist/server.mjs"]
