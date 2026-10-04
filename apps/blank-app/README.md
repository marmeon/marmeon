# Blank app

An app without modules — what `bespoke make:auth` is tested against (`packages/auth/src/make-auth.test.ts`):
the test copies it, generates the auth module, migrates, type-checks and runs the generated tests (on Postgres too
with `pnpm test:pgsql`). Keep it minimal: it stands for a new project.

Besides `system` it has what every new app should start with: `middleware/SecurityHeaders.ts` (`nosniff`, a referrer policy,
`X-Frame-Options`, and an HSTS switch to turn on once the site is HTTPS only) and a strict Content-Security-Policy with a nonce
per response (`contentSecurityPolicy()` in `bootstrap/app.ts`, E147 —
[Content-Security-Policy](../../packages/http/README.md#content-security-policy-e147)).
