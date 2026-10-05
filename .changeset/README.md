# Changesets

Every change an app can notice gets a changeset: `pnpm changeset` asks for the packages and the bump and writes a Markdown file
here, which the release turns into the version and the changelogs (`pnpm changeset version`, run by the release workflow's
version pull request). See [CONTRIBUTING.md](../CONTRIBUTING.md#changesets-and-releases).

- **One version for everything** (E152): `.changeset/config.json` puts every `@bespokecore/*` package, `bespokecore` and
  `create-bespoke-app` into one `fixed` group — naming one package bumps them all.
- **0.x: `minor` for a break, `patch` for the rest.** A `major` changeset would jump to 1.0.0; `pnpm run ci`
  (`scripts/check-changesets.ts`) refuses it below 1.0.0. Every break also gets its entry in `UPGRADING.md`.
