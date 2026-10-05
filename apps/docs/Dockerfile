# syntax=docker/dockerfile:1
# The docs as an image (E142) — the monorepo variant of what `bespoke make:docker` writes for an app: the framework is built from
# this checkout instead of installed from npm. Build it from the repository's root (the build context is the whole repository;
# apps/docs/Dockerfile.dockerignore keeps .env files, node_modules, builds and the other apps' code out):
#
#   docker build -f apps/docs/Dockerfile -t bespokecore-docs .
#   docker run --init --read-only -p 3000:3000 -e APP_KEY=base64:… -e APP_URL=https://docs.example.com \
#     -v bespokecore-docs-storage:/app/storage bespokecore-docs
#
# deploy/docs/compose.yaml runs it behind Caddy (TLS, HTTP/2 and HTTP/3). The pages are this checkout's READMEs and guides,
# copied into the image (/app/content): a new version of the docs is a new image.

ARG NODE_IMAGE=node:26-slim

# ── Build: the framework, the docs' bundles, then the docs app alone with its production dependencies ─────────────────────
FROM ${NODE_IMAGE} AS build
# pnpm as the repository pins it ("packageManager" in package.json) — Node ships no Corepack since 25.
RUN npm install --global --no-audit --no-fund pnpm@12.9.0
WORKDIR /repo
# Every dependency into the store from the lockfile alone: this layer is rebuilt only when pnpm-lock.yaml changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --store-dir /pnpm/store
COPY . .
# No .env file in the build, ever (Dockerfile.dockerignore): the server's secrets live in deploy/docs/.env — inside this context.
RUN if find . -name '.env*' -not -path '*/node_modules/*' | grep -q .; then \
      echo 'A .env file is in the build context — apps/docs/Dockerfile.dockerignore must keep it out:' >&2; \
      find . -name '.env*' -not -path '*/node_modules/*' >&2; exit 1; fi
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --offline --store-dir /pnpm/store
# The packages' dist/ — what the docs run on, as an app installed from npm would — then the docs' build (bundles, compressed
# assets, injection lists). `bespoke build` boots the app once: with a throwaway key, gone with this step.
RUN pnpm run build \
 && cd apps/docs \
 && APP_KEY="$(node ../../packages/cli/bin/bespoke.js key:generate --show)" node ../../packages/cli/bin/bespoke.js build
# The docs app as it runs: its files ("files" in its package.json — no tests, no .env), only its production dependencies, the
# framework's packages copied with their dist/ (pnpm deploy) and the manifests they are published with; the build's output; then
# the discovery manifest of exactly these packages (E160), so the start rewrites nothing and the files may be read-only.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm --filter @bespokecore/docs deploy --prod --prefer-offline --store-dir /pnpm/store /out \
 && node scripts/published-manifests.ts /out \
 && cp -R apps/docs/dist /out/dist \
 && mkdir -p /out/.bespoke && cp apps/docs/.bespoke/injections.json /out/.bespoke/ \
 && cd /out && node_modules/.bin/bespoke discover
# The pages: the READMEs and guides of this checkout, with each package's package.json (the docs check one against the other).
RUN mkdir -p /out/content/docs \
 && cp README.md UPGRADING.md CONTRIBUTING.md SECURITY.md /out/content/ \
 && cp docs/*.md /out/content/docs/ \
 && for dir in packages/*/; do mkdir -p "/out/content/$dir" && cp "${dir}package.json" "${dir}README.md" "/out/content/$dir"; done

# ── Run: Node and the docs, nothing to build with ──────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DOCS_SOURCE=/app/content PATH=/app/node_modules/.bin:$PATH
WORKDIR /app
# The code belongs to root and everyone may read it (pnpm writes its lockfile with 0600); storage/ — the rate limit's cache and
# Node's compile cache — belongs to the user the docs run as. Mount a volume there (deploy/docs/compose.yaml does).
COPY --from=build --chmod=a+rX /out ./
RUN mkdir -p storage/framework/cache && chown -R node:node storage
USER node
EXPOSE 3000
# Liveness (/up, E126) with Node's fetch — the image has no curl.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+(process.env.HEALTH_PATH||'/up')).then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"]
# bespoke is the process — one Node (E159). Run it behind an init (docker run --init, compose init: true).
ENTRYPOINT ["bespoke"]
CMD ["start"]
