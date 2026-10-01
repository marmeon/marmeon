# Blank app

An app without modules — what `bespoke make:auth` is tested against (`packages/auth/src/make-auth.test.ts`):
the test copies it, generates the auth module, migrates, type-checks and runs the generated tests (on Postgres too
with `pnpm test:pgsql`). Keep it minimal: it stands for a new project.
