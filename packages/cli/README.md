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

## Documentation

- [Console](https://github.com/marmeon/marmeon/blob/main/docs/console.md)
- [Console: the development server](https://github.com/marmeon/marmeon/blob/main/docs/console.md#the-development-server)
- [Console: writing commands](https://github.com/marmeon/marmeon/blob/main/docs/console.md#writing-commands)
- [Console: lint](https://github.com/marmeon/marmeon/blob/main/docs/console.md#lint)
- [Deployment](https://github.com/marmeon/marmeon/blob/main/docs/deployment.md)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
