# @marmeon/devtools

What a Marmeon app did while you develop — requests, queries, jobs, mails, logs and exceptions, redacted — under
`/_marmeon/devtools` and in a bar on every page. Development only.

## Installation

A dev dependency of every new Marmeon app. In another app:

```sh
pnpm add -D @marmeon/devtools
```

The devtools run only with `NODE_ENV=development`, which `marmeon dev` sets. Under `test`, `production` (whatever `APP_ENV`
says) or no `NODE_ENV` nothing is recorded and their pages answer `404`.

## Settings

The defaults record everything. `config/devtools.ts` changes that:

```ts title="config/devtools.ts"
import { defineDevtools } from '@marmeon/devtools';

export default defineDevtools({
  record: ['requests', 'queries', 'jobs', 'mails', 'logs', 'exceptions'],
  ignore: { paths: ['/_marmeon/live'] },
  slowQueryMs: 50,
});
```

## Documentation

- [Devtools](https://github.com/marmeon/marmeon/blob/main/docs/devtools.md)
- [Devtools: only in development](https://github.com/marmeon/marmeon/blob/main/docs/devtools.md#only-in-development)
- [Devtools: settings](https://github.com/marmeon/marmeon/blob/main/docs/devtools.md#settings)
- [Observability](https://github.com/marmeon/marmeon/blob/main/docs/observability.md)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
