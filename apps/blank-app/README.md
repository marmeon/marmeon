# Blank app

An app without modules — what `create-bespoke-app --minimal` writes ([create-bespoke-app](../../packages/create-bespoke-app/README.md),
E167): `pnpm template:sync` copies it into the scaffolder's template (`.gitignore` and `package.json` stored as `_gitignore` and
`_package.json`, a standalone `tsconfig.json`, empty `APP_KEY`s; this README stays here), and a test fails while the two differ.
Edit it here, then sync. The starter kit is this app plus the home module and `bespoke make:auth`.

It is also what `bespoke make:auth` is tested against (`packages/auth/src/make-auth.test.ts`): the test copies it, generates the
auth module, migrates, type-checks and runs the generated tests (on Postgres too with `pnpm test:pgsql`). Keep it minimal: it
stands for a new project — with the devtools as a dev dependency, a first test (`modules/system/system.test.ts`) and `pnpm test`.

Besides `system` it has what every new app should start with: `middleware/SecurityHeaders.ts` (`nosniff`, a referrer policy,
`X-Frame-Options`, and an HSTS switch to turn on once the site is HTTPS only) and a strict Content-Security-Policy with a nonce
per response (`contentSecurityPolicy()` in `bootstrap/app.ts`, E147 —
[Content-Security-Policy](../../packages/http/README.md#content-security-policy-e147)).
