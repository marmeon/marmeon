# @marmeon/testing

Feature tests for Marmeon apps with Vitest: the real application and its HTTP kernel without a server, requests and
assertions, a fresh database per test, fakes and a clock you move.

## Installation

A dev dependency of every new Marmeon app, next to `vitest` 5, which is its peer. `vitest.config.ts` uses the app's Vite plugin in
its test mode: `plugins: [marmeon({ test: true })]`.

## A first test

```ts title="modules/notes/notes.test.ts"
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';

it('shows the notes to a signed-in user', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  await app.actingAs(ada).navigating().get('/notes').assertOk().assertPage('notes/Index');
  await app.get('/notes').assertRedirect('/login');
});
```

## Documentation

- [Testing: Getting Started](https://marmeon.com/docs/testing)
- [HTTP Tests](https://marmeon.com/docs/http-tests)
- [Testing Pages](https://marmeon.com/docs/testing-pages)
- [Database Testing](https://marmeon.com/docs/database-testing)
- [Fakes](https://marmeon.com/docs/fakes)
- [Time](https://marmeon.com/docs/time)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
