# Blank app

An app without modules — what `create-marmeon --minimal` writes ([create-marmeon](../../docs/installation.md#a-blank-app)):
`pnpm template:sync` copies it into the scaffolder's template (`.gitignore` and `package.json` stored as `_gitignore` and
`_package.json`, a standalone `tsconfig.json`, empty `APP_KEY`s; this README stays here), and a test fails while the two differ.
Edit it here, then sync. The starter kit is this app plus the home module and `marmeon make:auth`.

It is also what `marmeon make:auth` is tested against (`packages/auth/src/make-auth.test.ts`): the test copies it and generates the
auth module; migrate, type-check, lint, the generated tests and the build run on the starter kit (`packages/create-marmeon/src/kit.test.ts`). Keep it minimal: it
stands for a new project — with `marmeon` as a dependency (production runs `marmeon start`), the devtools as a dev
dependency, a first test (`modules/system/system.test.ts`, `GET /up`) and `pnpm test`; `.env.example` with
`NODE_ENV=development` (this machine's environment for every `marmeon` command — never deployed) and a `storage/` skeleton
whose `.gitignore` files keep what the app writes out of git.

Besides `system` it has what every new app should start with, both global middleware in `bootstrap/app.ts`:
`securityHeaders()` on every response (`nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
`X-Frame-Options: DENY`, and `hsts` — off — to turn on once the site is HTTPS only; [the other security headers](../../docs/csp.md#the-other-security-headers)) and a strict Content-Security-Policy with a nonce per response on every document
(`contentSecurityPolicy()` — [Content-Security-Policy](../../docs/csp.md#adding-directives)): add
directives for what your pages load from elsewhere.
