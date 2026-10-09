# @marmeon/encryption

Authenticated encryption with the application key for Marmeon apps (AES-256-GCM on `node:crypto`), with contexts and key
rotation.

## Installation

Every new Marmeon app has it: it comes as a dependency of `@marmeon/http` and `@marmeon/session`. It needs no third-party
library. `APP_KEY` is set by `pnpm create marmeon`; `pnpm marmeon key:generate` writes one.

## Encrypting a value

```ts title="modules/exports/ExportLinks.ts"
import { Encrypter } from '@marmeon/encryption';

export class ExportLinks {
  readonly #encrypter: Encrypter;

  constructor(encrypter: Encrypter) {
    this.#encrypter = encrypter;
  }

  seal(exportId: number): Promise<string> {
    return this.#encrypter.encrypt(JSON.stringify({ exportId }), 'exports:download');
  }

  async open(payload: string): Promise<{ exportId: number }> {
    return JSON.parse(await this.#encrypter.decrypt(payload, 'exports:download'));
  }
}
```

The context, `'exports:download'`, binds a payload to its purpose: what was sealed for one context never opens in another.

## Documentation

- [Encryption](https://github.com/marmeon/marmeon/blob/main/docs/encryption.md)
- [Encryption: rotating the key](https://github.com/marmeon/marmeon/blob/main/docs/encryption.md#rotating-the-key)
- [Security: keys](https://github.com/marmeon/marmeon/blob/main/docs/security.md#keys)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
