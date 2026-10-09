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
```

`GET /up` answers once the app booted, `GET /up/ready` runs every health check of the app and its packages. On `SIGTERM` the
server leaves readiness, finishes the requests in flight and exits.

## Documentation

- [Request Lifecycle](https://github.com/marmeon/marmeon/blob/main/docs/lifecycle.md)
- [Deployment](https://github.com/marmeon/marmeon/blob/main/docs/deployment.md)
- [Deployment: stopping without dropped requests](https://github.com/marmeon/marmeon/blob/main/docs/deployment.md#stopping-without-dropped-requests)
- [Health Checks](https://github.com/marmeon/marmeon/blob/main/docs/health.md)
- [Error Handling: the development error page](https://github.com/marmeon/marmeon/blob/main/docs/errors.md#the-development-error-page)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
