# @marmeon/core

The application kernel of Marmeon: modules, service providers, the container with constructor injection, configuration,
events, the clock, the context of a request or job, results for expected failures, the diagnostics channels and health checks.

## Installation

Part of every new Marmeon app: `pnpm create marmeon` installs it.

## A module and its configuration

```ts title="modules/notes/config.ts"
import { defineConfig, env, type ConfigOf } from '@marmeon/core';

export const NotesConfig = defineConfig('notes', {
  env: env({
    NOTES_PER_PAGE: env.integer().min(5).max(100).default(25),
    NOTES_SHARING: env.boolean().default(false),
  }),
  resolve: (e) => ({ perPage: e.NOTES_PER_PAGE, sharing: e.NOTES_SHARING }),
});
export type NotesConfig = ConfigOf<typeof NotesConfig>;
```

```ts title="modules/notes/index.ts"
import { defineModule } from '@marmeon/core';
import { NotesConfig } from './config.ts';
import routes from './routes.ts';

export default defineModule({
  name: 'notes',
  config: [NotesConfig],
  routes,
});
```

The module joins the app in `modules` of `defineApplication()` in `bootstrap/app.ts`. Any class that asks for `NotesConfig` in its
constructor gets the checked values: the container injects by type, from generated lists, without decorators. `env` reads the
variables without a validation library; an empty variable counts as missing. `environment` answers whether the app is in
development or protected (`NODE_ENV`: `development`, `test` or `production`, nothing else starts), and `EnvironmentConfig` names it
(`APP_ENV`).

## Documentation

- [Modules & Discovery](https://marmeon.com/docs/modules)
- [Service Container](https://marmeon.com/docs/container)
- [Service Providers](https://marmeon.com/docs/providers)
- [Configuration](https://marmeon.com/docs/configuration)
- [Configuration: `NODE_ENV` and `APP_ENV`](https://marmeon.com/docs/configuration#the-environment-node_env)
- [Events](https://marmeon.com/docs/events)
- [Context](https://marmeon.com/docs/context)
- [Health Checks](https://marmeon.com/docs/health)
- [Observability](https://marmeon.com/docs/observability)
- [Error Handling: results](https://marmeon.com/docs/errors#results)
- [Error Handling: solutions](https://marmeon.com/docs/errors#solutions)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
