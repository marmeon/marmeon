# syntax=docker/dockerfile:1
# The docs as an image — the monorepo variant of what `marmeon make:docker` writes for an app: the framework is built from
# this checkout instead of installed from npm. Build it from the repository's root (the build context is the whole repository;
# apps/website/Dockerfile.dockerignore keeps .env files, node_modules, builds and the other apps' code out):
#
#   docker build -f apps/website/Dockerfile -t marmeon-website .
#   docker run --read-only -p 3000:3000 -e APP_KEY=base64:… -e APP_URL=https://docs.example.com \
#     -v marmeon-website-storage:/app/storage marmeon-website
#
# deploy/website/compose.yaml runs it behind Caddy (TLS, HTTP/2 and HTTP/3). The pages are this checkout's docs, copied into the
# image (/app/content): a new version of the docs is a new image.

ARG NODE_IMAGE=node:26-slim

# ── Build: the framework, the docs' bundles, then the docs app alone with its production dependencies ─────────────────────
FROM ${NODE_IMAGE} AS build
# pnpm as the repository pins it ("packageManager" in package.json) — Node ships no Corepack since 25.
RUN npm install --global --no-audit --no-fund pnpm@12.9.1
WORKDIR /repo
# Every dependency into the store from the lockfile alone: this layer is rebuilt only when pnpm-lock.yaml changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --store-dir /pnpm/store
COPY . .
# No .env file in the build, ever (Dockerfile.dockerignore): the server's secrets live in deploy/website/.env — inside this context.
RUN if find . -name '.env*' -not -path '*/node_modules/*' | grep -q .; then \
      echo 'A .env file is in the build context — apps/website/Dockerfile.dockerignore must keep it out:' >&2; \
      find . -name '.env*' -not -path '*/node_modules/*' >&2; exit 1; fi
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --offline --store-dir /pnpm/store
# The packages' dist/ — what the docs run on, as an app installed from npm would — then the docs' build (bundles, compressed
# assets, injection lists). `marmeon build` needs no key and no other secret: it registers the app without booting it.
RUN pnpm run build \
 && cd apps/website \
 && NODE_ENV=production node ../../packages/cli/bin/marmeon.js build
# The docs app as it runs: its files ("files" in its package.json — no tests, no .env), only its production dependencies, the
# framework's packages copied with their dist/ (pnpm deploy); the build's output; then the discovery manifest of exactly these
# packages, so the start rewrites nothing and the files may be read-only. The copies keep the workspace's manifests —
# `exports` with the source condition — which nothing sets here: `marmeon` gives it only inside the workspace, so every
# command runs dist/ like a published package.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm --filter @marmeon/website deploy --prod --prefer-offline --store-dir /pnpm/store /out \
 && cp -R apps/website/dist /out/dist \
 && mkdir -p /out/.marmeon && cp apps/website/.marmeon/injections.json /out/.marmeon/ \
 && cd /out && node_modules/.bin/marmeon discover
# The pages: the docs of this checkout — docs/*.md and the policies at the root. The packages' READMEs are cards for npm, no pages.
RUN mkdir -p /out/content/docs \
 && cp UPGRADING.md CONTRIBUTING.md SECURITY.md /out/content/ \
 && cp docs/*.md /out/content/docs/

# ── Run: Node and the docs, nothing to build with ──────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}
# tini as PID 1: it passes signals on to marmeon and reaps orphaned processes — Node as PID 1 reaps none.
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DOCS_SOURCE=/app/content PATH=/app/node_modules/.bin:$PATH
WORKDIR /app
# The code belongs to root and everyone may read it (pnpm writes its lockfile with 0600); storage/ — the rate limit's cache and
# Node's compile cache — belongs to the user the docs run as. Mount a volume there (deploy/website/compose.yaml does).
COPY --from=build --chmod=a+rX /out ./
RUN mkdir -p storage/framework/cache && chown -R node:node storage
USER node
EXPOSE 3000
# Liveness (/up) with Node's fetch — the image has no curl.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const p=process.env.HEALTH_PATH||'/up';p==='off'?process.exit(0):fetch('http://127.0.0.1:'+(process.env.PORT||3000)+p).then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"]
# marmeon is the process — one Node — under tini: SIGTERM reaches it, its exit code (0 after a drain) is the container's.
ENTRYPOINT ["/usr/bin/tini", "--", "marmeon"]
CMD ["start"]
