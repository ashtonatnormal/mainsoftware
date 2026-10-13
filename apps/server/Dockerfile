# The Hearth server image (T2, docs/TECH-SPEC.md): one image for the api, realtime and worker
# roles (ROLE chooses), in which Node runs apps/server's .ts source as it is. There is no build
# step and no TypeScript tooling: the image holds the source, the server's production
# dependencies, and npm's links to the workspace packages it uses. Those must stay links into
# packages/: Node refuses to strip types from a file under node_modules, so a copied package
# would fail at start.
#
# Build from the repo root, which apps/server/Dockerfile.dockerignore trims to what is copied:
#   docker build -f apps/server/Dockerfile -t hearth-server .
# CI builds it and runs every role (scripts/check-server.sh).

# Stage 1: the server's production dependencies, exactly as the lockfile pins them, with no
# install scripts. Every workspace package is copied and `--workspace` links only the ones the
# server depends on, so a new dependency between workspaces needs no change here.
FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server apps/server
COPY packages packages
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --workspace @hearth/server --ignore-scripts --no-audit --no-fund --no-update-notifier

# Stage 2: what runs.
FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66

# npm, corepack and yarn come with the base image, but nothing runs them, and image scanners
# report their bundled dependencies' vulnerabilities, so they go.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

# The load balancer reaches the server on every interface; 3000 unless PORT says otherwise.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
EXPOSE 3000

WORKDIR /app
COPY --from=deps /app ./
# Where apps/server/src/db/migrations.ts looks for them: db/migrations/ beside apps/.
COPY db/migrations db/migrations

# Not root, and nothing written at run time, so the task can run with a read-only root filesystem.
USER node
WORKDIR /app/apps/server
# Node as the main process (the base image's entrypoint execs it; no npm or shell in between), so
# SIGTERM reaches the server.
CMD ["node", "src/main.ts"]
