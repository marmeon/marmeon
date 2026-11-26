# An Area of Its Own

## Introduction

A package can bring a whole area of its own, such as an admin section or a status board. This page ties the routes, the pages and the texts of [Routes & Middleware](package-routes.md) and [Pages & Components](package-pages.md) together, and shows what the app does with the area.

## A package with an area of its own

A package that brings an area, an admin section or a status board, ties the pieces of the earlier pages together: routes behind its own access check, pages
in a document of its own, texts the app may reword and a policy for that document. The status board of the web app is such a package, and the
code below is shortened from it (`fixtures/status-board`).

The package serves server code from its main entry, where its provider is, and the components an app renders on its own pages from
`./components`. The main entry exports the provider, which imports `@marmeon/auth` and the router, so a browser import of `.` would pull
server code into the client bundle:

```json title="package.json"
{
  "name": "@acme/status-board",
  "type": "module",
  "exports": {
    ".": "./dist/index.js",
    "./components": "./dist/components.js",
    "./area/client": "./dist/area/client.js",
    "./area/ssr": "./dist/area/ssr.js",
    "./views/*": "./dist/views/*.js",
    "./lang/*": "./dist/lang/*.js"
  },
  "marmeon": {
    "providers": ["StatusBoardServiceProvider"],
    "namespace": "status",
    "entry": { "client": "./area/client", "ssr": "./area/ssr" },
    "views": "./views",
    "lang": "./lang",
    "browser": ["src/area/**", "src/views/**", "src/components.ts", "src/*.tsx"]
  },
  "peerDependencies": {
    "@marmeon/auth": "^0.1.0",
    "@marmeon/core": "^0.1.0",
    "@marmeon/http": "^0.1.0",
    "@marmeon/i18n": "^0.1.0",
    "@marmeon/react": "^0.1.0",
    "react": "^19.3.0"
  }
}
```

### The routes, the access check and the policy

The provider loads the routes below a path from its configuration, so the app can move the area. Its routes carry the area's policy, ask
for a signed-in user and then for the app's decision:

```ts title="src/StatusBoardServiceProvider.ts"
import { authenticate } from '@marmeon/auth';
import type { Container, ServiceProvider } from '@marmeon/core';
import { contentSecurityPolicy, defineRoutes, describeAccess, NONCE, Router } from '@marmeon/http';
import { ShowStatusController } from './ShowStatusController.ts';
import { StatusAccess } from './StatusAccess.ts';
import { StatusBoardConfig } from './StatusBoardConfig.ts';

export class StatusBoardServiceProvider implements ServiceProvider {
  static config = [StatusBoardConfig];

  register(container: Container): void {
    const { path } = container.make(StatusBoardConfig);
    const policy = contentSecurityPolicy({ styleSrc: ["'self'", NONCE], imgSrc: ["'self'"], connectSrc: ["'self'"], frameAncestors: ["'none'"] });
    container.make(Router).load(
      { group: 'web', prefix: path },
      defineRoutes((Route) => {
        Route.middleware(policy)
          .middleware(authenticate())
          .authorize(describeAccess(async (ctx) => (container.has(StatusAccess) ? await container.make(StatusAccess).allows(ctx.user) : false), 'status access'))
          .get('/', ShowStatusController)
          .name('status.index');
      }),
    );
  }
}
```

```ts title="src/StatusAccess.ts"
import type { AuthUser } from '@marmeon/auth';
import { token } from '@marmeon/core';

/** Who may open the area. The app binds it; the package never decides for it. */
export interface StatusAccess {
  allows(user: AuthUser): boolean | Promise<boolean>;
}
export const StatusAccess = token<StatusAccess>('StatusAccess');
```

- **The gate fails closed.** Every route needs a decision (see [authorization](authorization.md#every-route-decides)). This one asks the
  app through a token the package defines. An app that binds nothing opens nothing: every user gets a 403, and a guest is sent to the sign-in
  by `authenticate()` before the check runs. The controller renders the page only after the check, so a refused request never builds
  the area's document.
- **The policy is the route group's.** A response that sets none gets the [strict default](csp.md#policies-of-a-package-area) with its
  nonce; a policy of the group, as here, replaces both that default and the app's global one for the area's pages.
- **The routes load in `register()`**, so `marmeon route:types` lists `status.index` and a page of the app can link to it.

### The entry, a page and its texts

The client entry starts the app in the browser with the area's own pages and texts, and the server entry renders them:

```tsx title="src/area/client.tsx"
import { createMarmeonApp, resolveModulePages } from '@marmeon/react';
import '@marmeon/react/styles.css';
import { createMessageLoader } from '@marmeon/i18n/messages';
import lang from 'virtual:marmeon/lang/status';
import pages from 'virtual:marmeon/pages/status';
import { routes } from 'virtual:marmeon/routes';

void createMarmeonApp({ resolve: resolveModulePages(pages), routes, messages: createMessageLoader(lang) });
```

```tsx title="src/area/ssr.tsx"
import { createMessageLoader } from '@marmeon/i18n/messages';
import { resolveModulePages } from '@marmeon/react';
import { createSsrRenderer } from '@marmeon/react/server';
import lang from 'virtual:marmeon/lang/status';
import pages from 'virtual:marmeon/pages/status';
import { routes } from 'virtual:marmeon/routes';

export const render = createSsrRenderer(resolveModulePages(pages), { routes, messages: createMessageLoader(lang) });
```

The page is `status::Index`, the file `views/Index.tsx`. It links back to the app by route name, and the area's route names and the app's share one
manifest:

```tsx title="src/views/Index.tsx"
import type { PageProps } from '@marmeon/http';
import { Head, Link, useTranslation } from '@marmeon/react';
import type { ShowStatusController } from '../ShowStatusController.ts';
import { StatusBoard } from '../StatusBoard.tsx';

export default function Index({ services }: PageProps<ShowStatusController>) {
  const t = useTranslation('status');
  return (
    <main>
      <Head title={t('title')} />
      <h1>{t('title')}</h1>
      <StatusBoard services={services} />
      <Link route="dashboard.show">{t('back')}</Link>
    </main>
  );
}
```

```ts title="src/ShowStatusController.ts"
import { Controller } from '@marmeon/http';

export class ShowStatusController extends Controller {
  handle() {
    return this.view('status::Index', { services: [{ name: 'Web', state: 'up' }] });
  }
}
```

The texts are `src/lang/en.ts` with `title`, `intro` and `back` (declared in `Translations` as [a module's are](localization.md#texts-of-a-package)),
and `de.ts` next to it.

### What the app does

The app decides who may open the area, by binding the token in a provider of one of its modules, and rewords a text of the package in
`lang/status/de.ts`:

```ts title="modules/dashboard/StatusAccessServiceProvider.ts"
import { StatusAccess } from '@acme/status-board';
import type { VerifiableUser } from '@marmeon/auth';
import type { Container, ServiceProvider } from '@marmeon/core';
import { DashboardConfig } from './config.ts';

export class StatusAccessServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(StatusAccess, (resolver) => {
      const { admins } = resolver.make(DashboardConfig);
      return { allows: (user) => (user as VerifiableUser).email_verified_at != null && admins.includes(user.email.toLowerCase()) };
    });
  }
}
```

```ts title="lang/status/de.ts"
import type en from '@acme/status-board/lang/en';
import type { MessageOverrides } from '@marmeon/i18n/messages';

export default {
  title: 'Systemzustand',
} satisfies MessageOverrides<typeof en>;
```

An allowlist of addresses needs confirmed addresses: anybody can sign up with a listed one, so the check above also asks for
`email_verified_at`, the notion `verified()` uses. An account that has not confirmed its address gets a 403 whatever its address.

A page of the app links to the area by `<Link route="status.index">`. That visit loads the area's document fully: the answer is a `409` that
names the address, and the browser loads it (see [a visit into another entry](navigation.md#a-visit-into-another-entry)). The link back
does the same the other way.

### What the area keeps out of the app's pages

`marmeon build` writes one client build with an entry for the app and one for the area (see [packages with an entry](vite.md#packages-with-an-entry)).
The document of a public page loads nothing that only the area's entry reaches: not its code, not its stylesheets and not its texts, in any
language. Texts of an area that an administrator reads stay out of the public bundle. A text a public page needs belongs to the app, and reaches
the page as a prop.

The web app proves it. `apps/web-app/modules/dashboard/status-area.test.ts` signs in as an administrator, as another member and as a
guest, reads the area's document, its policy and its texts, and crosses the boundary in both directions;
`status-area-build.test.ts` builds a copy of the app and checks the built files.
