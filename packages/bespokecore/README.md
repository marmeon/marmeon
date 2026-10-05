# bespokecore

The meta package: BespokeCore in one name. It contains no code — only the framework packages a BespokeCore app runs on, each at
exactly the version of this package (E157). The framework is released in lockstep (E152): every `@bespokecore/*` package,
`bespokecore` and `create-bespoke-app` always carry the same version, and `bespokecore@0.1.0` names that set.

```sh
npm install bespokecore @bespokecore/react react react-dom   # the runtime set in one line, plus the UI adapter of your choice
```

## What it contains

The **UI-agnostic** runtime of the starter kit — what an app made with [create-bespoke-app](../create-bespoke-app/README.md)
lists in `dependencies`, without its UI adapter: [auth](../auth/README.md), [cache](../cache/README.md), [cli](../cli/README.md),
[core](../core/README.md), [database](../database/README.md), [http](../http/README.md), [i18n](../i18n/README.md),
[log](../log/README.md), [mail](../mail/README.md), [queue](../queue/README.md), [router](../router/README.md),
[scheduler](../scheduler/README.md), [server](../server/README.md) and [session](../session/README.md) (with
[encryption](../encryption/README.md), which several of them depend on).

Not in it, on purpose:

- **the UI adapter** — [react](../react/README.md) today, others later (E39): the app chooses its adapter and lists it itself
  (`pnpm add @bespokecore/react react react-dom`), so the meta package has no `react` or `react-dom` peers and stays the same
  whichever UI an app uses;
- **development tools** — [vite](../vite/README.md), [testing](../testing/README.md) and [devtools](../devtools/README.md) belong
  in `devDependencies` (a production install leaves them out; the devtools never reach a server);
- **opt-in packages** — [redis](../redis/README.md), [storage](../storage/README.md), [live](../live/README.md),
  [notifications](../notifications/README.md) and [otel](../otel/README.md): installed packages register themselves (discovery),
  so each is added when the app wants it (`pnpm add @bespokecore/storage`).

`pnpm run ci` keeps this list honest (`scripts/check-changesets.ts`): the blank app's runtime packages minus the UI adapters,
nothing else.

## With pnpm, list what you import

pnpm gives an app only the packages its own `package.json` names — a dependency of `bespokecore` is installed, discovered and
booted, but `import { Controller } from '@bespokecore/router'` needs `@bespokecore/router` in the app's `package.json`. That is
why `create-bespoke-app` writes every package the app imports, at the same exact version, and does not use `bespokecore` itself.
If you add `bespokecore` next to them, keep both at one version: two versions of a framework package mean two containers and
two `Application` classes in one process.

## Versions

The version policy — 0.x, where a minor version may break, every break in [UPGRADING.md](../../UPGRADING.md) — is in the
[root README](../../README.md#versions-and-deprecations).
