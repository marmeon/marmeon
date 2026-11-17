# @marmeon/fetch

Outgoing HTTP requests for Marmeon apps: the client refuses addresses that are not public, follows redirects itself and limits time and size, and a fake answers requests in tests.

## Installation

A new app has it. Otherwise:

```sh
pnpm add -E @marmeon/fetch@<version of your app>
```

## A first request

```ts
import { HttpClient } from '@marmeon/fetch';

export class Hooks {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  async ping(url: string): Promise<number> {
    const response = await this.#http.fetch(url, { method: 'POST', json: { ping: true }, timeout: 5 });
    await response.body?.cancel();
    return response.status;
  }
}
```

## Documentation

- [HTTP client](https://marmeon.com/docs/http-client)
- [HTTP client: what is refused](https://marmeon.com/docs/http-client#what-is-refused)
- [Fetch transports](https://marmeon.com/docs/drivers#fetch-transports)
- [Fakes: outgoing requests](https://marmeon.com/docs/fakes#outgoing-requests)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
