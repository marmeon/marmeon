# @marmeon/server

The HTTP server of Marmeon apps: the kernel, server rendering through Vite or the build, the health endpoints and a graceful
stop without dropped requests.

## Installation

Part of every new Marmeon app: `pnpm create marmeon` installs it.

Vite is a peer, never a dependency: the server runs the app's own Vite in development, and `marmeon build` needs it. A new app
has `vite` and `@marmeon/vite` as dev dependencies; `marmeon start` serves the build without them.

## Building and starting

```sh
pnpm marmeon build    # injection lists, route types, type check, the browser's files and the server rendering
pnpm marmeon start    # serves the build: NODE_ENV=production unless the environment or .env says otherwise
NODE_ENV=production APP_ENV=staging pnpm marmeon start   # a staging server: production, named staging
```

`NODE_ENV` is `development`, `test` or `production`; any other value stops the start. `APP_ENV` names the environment and picks
the scheduled tasks of `.environments()`; it never weakens a protection or turns on a development tool.

`GET /up` answers once the app booted, `GET /up/ready` runs every health check of the app and its packages. On `SIGTERM` the
server leaves readiness, finishes the requests in flight and exits.

## Documentation

- [Request Lifecycle](https://marmeon.com/docs/lifecycle)
- [Deployment](https://marmeon.com/docs/deployment)
- [Deployment: staging](https://marmeon.com/docs/deployment#staging)
- [Deployment: stopping without dropped requests](https://marmeon.com/docs/deployment#stopping-without-dropped-requests)
- [Health Checks](https://marmeon.com/docs/health)
- [Error Handling: the development error page](https://marmeon.com/docs/errors#the-development-error-page)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
