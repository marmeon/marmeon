# Building & Publishing

## Introduction

A published package runs its compiled JavaScript, and the app resolves its dependencies. This page covers how you build and publish a package, how a package that needs a third-party driver declares it, and how you deprecate an API.

## Building and publishing

Node strips types only outside `node_modules`, so a published package runs its compiled JavaScript. Publish `dist/` with its `.js`
and `.d.ts` files, and point `exports` at them. A package whose entry is TypeScript stops the app with Node's
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, and `marmeon` names the cause.

Build with `marmeon package:build`:

```sh
pnpm marmeon package:build --clean
```

It runs `tsc -b` for each directory you name, or the current one, and writes the injection lists and the island marks into the compiled files. Each
directory needs a `tsconfig.json` and TypeScript installed. A directory without a `tsconfig.json` stops the command before it builds
anything, with exit code 1 and the directory's name.
`--clean` empties `dist/` and the build info first, because `tsc -b` never deletes what a removed source left behind. A package
inside your app's workspace runs from its sources only when you [set that up](package-workspace.md#a-package-in-your-apps-workspace). Without it, the app
runs the package's `dist/`, so build the package after each change.

## Dependencies of drivers

A package that talks to a third-party service decides how the app gets its driver library. The framework's packages follow one
rule, and a package of yours should too:

1. A package that wraps exactly **one** library and is useless without it lists it in **`dependencies`**, at a caret range of the
   major you tested. `@marmeon/redis` brings `redis` that way, so the app installs one package.
2. A package with **several** drivers to choose from, usually one built in, keeps the third-party ones as **optional peer
   dependencies**. Its error names the exact install command with the major, such as `pnpm add @aws-sdk/client-s3@^3
   @aws-sdk/s3-request-presigner@^3`. Where the driver is surely used, such as a configured default disk on S3, the start fails
   with it, not the first request.
3. A library whose instance or types the app must **share** stays a **peer dependency**: React, Vite, the OpenTelemetry API. A
   dependency would install a second copy, and the two would not see each other.

Two decided exceptions keep a library as a dependency that rule 1 would not: `nodemailer` in `@marmeon/mail`, and
`@simplewebauthn/server` in `@marmeon/auth`, whose passkey verification is security-critical and which only the `@marmeon/auth/passkeys`
subpath loads.

The framework packages you build on are a different case. List them as `dependencies` with a caret range of the version the app
uses, as the framework's own packages list each other. A range alone does not give you the app's one copy: a version the app does
not satisfy installs a second copy, and a matching range can still install one, as the next section shows. A second copy has its own
`Router` and container tokens, which the app never sees.

The framework's packages are coupled the same way: an optional peer dependency on another framework package, such as
`@marmeon/redis` for a Redis cache, with a start that fails and names the package when the configuration needs it.
A static value import of such a peer anywhere reachable from an entry stops the package from loading in an app that lacks it. The
package loads the peer with `await import(…)` where it needs it and imports only types from it with `import type`. The peer counts
as absent only when it does not resolve itself (`import.meta.resolve`); a missing dependency of an installed peer, or any other load
error, stops the start.

### One copy of a framework package

pnpm installs one copy of a package for each set of peers it resolves, and the peers of its dependencies count too. A framework
package such as `@marmeon/database` has `pg` as a peer. If your app and your package resolve `pg` to different versions, pnpm
installs `@marmeon/database` twice. The same holds for `mysql2`, `@marmeon/redis`, `oxc-transform` and `typescript`.

A caret range does not prevent this. `^8` in your package and `8.23.1` in the app can resolve to two versions, and an install keeps
the version the lockfile holds. A package that lists `pg` as a `devDependency` gets the same result: it repairs no duplicate, and
another patch version there causes one.

To keep one copy:

1. Use one version of each peer across the workspace, in the app and in every package.
2. Do not turn off `dedupePeerDependents` in your `pnpm-workspace.yaml`.
3. Run `pnpm dedupe` after `pnpm --filter <app> add …`.

```sh
pnpm --filter <app> add pg@^8
pnpm dedupe
```

You may see the duplicate in these places:

- **Health check:** `Two health checks are named "database": …`.
- **Container:** `[marmeon:K1] No binding for [Router] (needed by Mailer). Bind it in a service provider.`, with a framework class in place of `Router`.
- **Container:** `[marmeon:K3] [Application] needs 1 constructor argument(s) but has no injection list …`.
- **`marmeon check` and `marmeon dev` (at each start):** the warning `ui resolves another copy of @marmeon/storage (the same version, other peers)`. See [the packages check](check.md#the-packages-check).
- **`marmeon tinker --sandbox`:** refuses with `--sandbox refuses: @marmeon/database is installed more than once, and writes through another copy would not be rolled back.`, and one line for each second copy. See [the sandbox](console.md#trying-things-in-a-sandbox).

The first three messages have other causes too: the check below tells them apart and confirms a duplicate.

A package that lists the framework as a `peerDependency` and as a `devDependency` can boot with two copies. Its imports resolve to
the copy of its own `node_modules`, not to the app's. List the framework packages as `dependencies`, as the section above says. Your package then resolves the app's copy whenever the peers agree, which the rule above covers.

To check, print the real path of the package from the app and from your package, and compare them:

```sh
cd <app> && node -e "console.log(require('fs').realpathSync(require.resolve('@marmeon/database')))"
cd <package> && node -e "console.log(require('fs').realpathSync(require.resolve('@marmeon/database')))"
```

The two paths must be equal. A path such as `.pnpm/@marmeon+database@1.2.2_pg@8.23.1/…` names the peers it was installed with, so a
different `pg@…` in the second path is the cause. These steps are for pnpm. npm and Yarn are not covered here.

## Deprecating an API

Remove an API in two steps: first mark it deprecated in a release, then delete it in the next major version. Mark it twice, in
the types and at run time:

```ts
import { deprecated } from '@marmeon/core/deprecation';

export class Greeter {
  /**
   * @deprecated Use {@link Greeter.greet} instead. Removed in 2.0; docs/greeter.md#greeting.
   */
  hello(name: string): string {
    deprecated('greeter.hello', 'Greeter.hello() is deprecated, use Greeter.greet() instead.', '2.0');
    return this.greet(name);
  }
}
```

`deprecated(id, message, removeIn)` warns once per `id`. Name the id `<package>.<name>`, let `message` name the replacement, and give
`removeIn` as the version that removes the API. Import it from `@marmeon/core/deprecation` in code that runs in the browser: that
entry point does not load the rest of the core.

The warning appears only when `NODE_ENV` is `development` or `test`, so production pays nothing. On the server it is a Node
`DeprecationWarning`: `node --no-deprecation` silences it, and `node --throw-deprecation` turns it into an error, which makes a
test run fail on deprecated calls.
