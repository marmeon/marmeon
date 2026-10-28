# @marmeon/vite

The Vite plugin of Marmeon apps: the entries, the virtual modules of pages, language files and routes, constructor injection,
and the check that keeps server code out of the browser.

## Installation

A dev dependency of every new Marmeon app. In another app, with React's plugin next to it:

```sh
pnpm add -D vite@^8 @marmeon/vite@<version of your app> @vitejs/plugin-react
```

Vite is a peer, never a dependency: the app's own Vite, with its plugins and config, is the one the framework runs.

## The config

```ts title="vite.config.ts"
import { marmeon } from '@marmeon/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [marmeon(), react()] });
```

## Documentation

- [Asset Bundling (Vite)](https://marmeon.com/docs/vite)
- [Vite: the dev server](https://marmeon.com/docs/vite#the-dev-server)
- [Vite: server code in the browser](https://marmeon.com/docs/vite#server-code-in-the-browser)
- [URL Generation: which routes the browser knows](https://marmeon.com/docs/urls#which-routes-the-browser-knows)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
