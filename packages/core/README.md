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

- [Modules & Discovery](https://github.com/marmeon/marmeon/blob/main/docs/modules.md)
- [Service Container](https://github.com/marmeon/marmeon/blob/main/docs/container.md)
- [Service Providers](https://github.com/marmeon/marmeon/blob/main/docs/providers.md)
- [Configuration](https://github.com/marmeon/marmeon/blob/main/docs/configuration.md)
- [Configuration: `NODE_ENV` and `APP_ENV`](https://github.com/marmeon/marmeon/blob/main/docs/configuration.md#the-environment-node_env)
- [Events](https://github.com/marmeon/marmeon/blob/main/docs/events.md)
- [Context](https://github.com/marmeon/marmeon/blob/main/docs/context.md)
- [Health Checks](https://github.com/marmeon/marmeon/blob/main/docs/health.md)
- [Observability](https://github.com/marmeon/marmeon/blob/main/docs/observability.md)
- [Error Handling: results](https://github.com/marmeon/marmeon/blob/main/docs/errors.md#results)
- [Error Handling: solutions](https://github.com/marmeon/marmeon/blob/main/docs/errors.md#solutions)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
