# Workspace Packages

## Introduction

A package that lives in your app's repository can run from its sources, with no build in between. This page sets up the condition, the setting and the environment variable that make it work, and lists what to watch for.

## A package in your app's workspace

A package that lives in your app's repository can run from its sources. You edit `src/`, and `marmeon dev`, `marmeon check` and
`marmeon migrate` run the edit, with no build in between. This section sets that up. It needs one condition in the package, one
setting in the app's `tsconfig.json` and one environment variable.

Marmeon does not switch this on by itself. Node runs a TypeScript file only when every construct in it can be stripped, so a
package written with an `enum` would stop a working app. You decide per package.

### Set it up

The package sits in a folder that your workspace lists. With pnpm, add these lines at the top of the `pnpm-workspace.yaml` your app
already has:

```yaml title="pnpm-workspace.yaml"
packages:
  - packages/*
```

The package's `exports` names the sources under the condition `@marmeon/source`, in front of `types` and `default`. The condition
stays out of `publishConfig.exports`, so a published package leads to its build only:

```json title="packages/status-board/package.json"
{
  "name": "@acme/status-board",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    ".": {
      "@marmeon/source": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "publishConfig": {
    "exports": {
      ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
    }
  },
  "files": ["dist"],
  "marmeon": {
    "providers": ["StatusBoardServiceProvider"]
  },
  "dependencies": {
    "@marmeon/core": "^1.0.0",
    "@marmeon/http": "^1.0.0"
  }
}
```

`marmeon package:build` compiles the package with this `tsconfig.json`:

```json title="packages/status-board/tsconfig.json"
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "rewriteRelativeImportExtensions": true,
    "strict": true,
    "declaration": true,
    "skipLibCheck": true,
    "types": ["node"],
    "composite": true,
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

The package answers a request and says where its code runs from. `import.meta.url` ends in `/src/index.ts` for the source and in
`/dist/index.js` for the build, and `process.pid` names the process that answers:

```ts title="packages/status-board/src/index.ts"
import type { Container, ServiceProvider } from '@marmeon/core';
import { Controller, defineRoutes, everyone, Router } from '@marmeon/http';

export const origin = import.meta.url.endsWith('/src/index.ts') ? 'source' : 'dist';

export class ShowStatusController extends Controller {
  handle() {
    return this.json({ origin, pid: process.pid });
  }
}

export class StatusBoardServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.make(Router).load(
      { group: 'web', prefix: '/status-board' },
      defineRoutes((Route) => {
        // Open to anyone on purpose: the page only says where the code runs from.
        Route.authorize(everyone).get('/', ShowStatusController);
      }),
    );
  }
}
```

In the app, TypeScript reads the condition from `customConditions`. Node reads it from `NODE_OPTIONS`, which a script of the app sets
for every `marmeon` command. Add both:

```json title="tsconfig.json"
{
  "compilerOptions": {
    "customConditions": ["@marmeon/source"]
  }
}
```

```json title="package.json"
{
  "scripts": {
    "marmeon": "NODE_OPTIONS=--conditions=@marmeon/source marmeon"
  }
}
```

Code in your app imports the package like any other. This path fits an app made from the starter kit, which has `modules/home`. In
another app, use a folder it has:

```ts title="modules/home/status.ts"
import { origin } from '@acme/status-board';

export const statusOrigin: 'source' | 'dist' = origin;
```

Install the package into the app, then run the commands through the script:

```sh
pnpm add @acme/status-board@workspace:*
pnpm marmeon migrate
pnpm marmeon check
pnpm marmeon dev
```

Open `/status-board`. It answers `{"origin":"source", …}` while no `dist/` exists. `marmeon check` passes because the type check
reads `src/index.ts` too. The Node flag has to come through `NODE_OPTIONS`. In PowerShell, which has no `NAME=value command` form, set
`$env:NODE_OPTIONS = '--conditions=@marmeon/source'` and run `marmeon` itself. `node --conditions=@marmeon/source …/marmeon.js` is no
substitute: the flag reaches that one process and none of its children, and `marmeon dev` serves from a child.

### What to watch for

- **`build` and `start` get no variable.** They check and serve what you ship, so run them as the app's own scripts, `pnpm build` and
  `pnpm start`. Build the package first with `pnpm marmeon package:build packages/status-board --clean`. Without its `dist/`,
  `marmeon build` stops with `Could not start the application: ENOENT` and the path of `dist/index.d.ts`. With it, `pnpm start` answers
  `{"origin":"dist", …}`.
- **A forgotten variable runs a stale `dist/` and says nothing.** `marmeon dev` without it loads the package's `dist/`, the build of the last
  time you made one. The page above then answers `dist`, and the output has no warning. Without a `dist/` the same call stops with
  `Could not start the application`.
- **Vite and Node can disagree.** The Vite plugin adds `@marmeon/source` to its own resolution in development and in tests, with or
  without the variable. Node adds it only through `NODE_OPTIONS`. Code that Vite bundles can then come from `src/` while Node loads `dist/`.
- **The sources run under Node's type stripping.** Write only syntax that `erasableSyntaxOnly` allows. An `enum` stops the app, and
  `marmeon check` reports it once your app imports the package, because the starter's `tsconfig.json` sets `erasableSyntaxOnly`.
- **`marmeon add` and `marmeon upgrade` stop.** The setup puts `packages` into your `pnpm-workspace.yaml`, and both commands refuse an
  app whose workspace lists packages: they say the directory is the root of a workspace. Install a framework package yourself, at
  the version of your app: `pnpm add -E @marmeon/<name>@<version of your app>`.
- **The variable is for the machine you work on.** The flag reaches every package, so a copy of your package under `node_modules` that
  still has its `src/` stops the app with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Do not set it in an image, on a server or in a
  deploy script.
- **Tests resolve the source, their children do not.** Vitest with `marmeon({ test: true })` loads `@acme/status-board` from `src/` in
  the test file and in the files it imports, with no variable. A process a test starts, such as `spawn(process.execPath, …)`, gets
  `dist/` or, without one, fails to load the package.

### Without a condition

A second way needs neither the condition nor the variable. Point `exports` at the sources, and let `publishConfig.exports` name the
build for the registry:

```json
{
  "exports": {
    ".": "./src/index.ts"
  },
  "publishConfig": {
    "exports": {
      ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
    }
  }
}
```

Every command now runs the package's sources, `marmeon start` included, so nothing needs a build. That is the price. Production runs
TypeScript, and `pnpm deploy` breaks it: it copies the package without applying `publishConfig.exports`, so the copy's `exports` still
name `./src/index.ts`. With `files` set to `dist`, the copy has no `src/` and the deployed app cannot load the package. With `src` in `files`, Node refuses
the TypeScript under `node_modules`. Use the condition when the package is deployed with the app.
