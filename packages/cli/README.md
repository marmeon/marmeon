# marmeon

The `marmeon` command of Marmeon apps: the development server, the build and the production start, migrations and workers,
generators, `tinker`, and the commands of the app and its packages.

## Installation

Part of every new Marmeon app: `pnpm create marmeon` installs it.

It is a dependency of the app, not a dev dependency: `marmeon start`, `migrate`, `queue:work` and `schedule:work` run on the
server, and a production install leaves dev dependencies out.

## A first command

```sh
pnpm marmeon list
pnpm marmeon route:list
pnpm marmeon make:controller ShowNote --module=notes --view
```

`marmeon list` prints every command the app has. Every installed package adds its commands, and so does every module that lists
some. With npm, run them as `npx marmeon …`.

Every command runs with `NODE_ENV` `development`, `test` or `production` and stops at any other value; a staging server is
`NODE_ENV=production APP_ENV=staging`. `marmeon build` builds the browser's files for production unless `NODE_ENV=development`.

## Documentation

- [Console](https://marmeon.com/docs/console)
- [Console: the development server](https://marmeon.com/docs/console#the-development-server)
- [Console: writing commands](https://marmeon.com/docs/console#writing-commands)
- [Console: lint](https://marmeon.com/docs/console#lint)
- [Configuration: the environment](https://marmeon.com/docs/configuration#the-environment-node_env)
- [Deployment](https://marmeon.com/docs/deployment)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
