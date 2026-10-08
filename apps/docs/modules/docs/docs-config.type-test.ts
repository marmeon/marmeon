import { defineDocs } from '../../docs.config.ts';

// docs.config.ts is typed against the packages: a name that is none, or a package left out, is a compile error.
// (The sections are checked when the app boots — their files are on disk, not in the types.)
defineDocs({
  sections: [],
  groups: [
    {
      title: 'Core',
      packages: ['core', 'cli', 'create-marmeon', 'log', 'encryption', 'testing', 'router', 'validation', 'http', 'server', 'session', 'vite', 'i18n', 'database', 'cache', 'redis', 'auth', 'mail', 'notifications', 'queue', 'scheduler', 'storage', 'live', 'table', 'react', 'devtools', 'otel'],
    },
  ],
});

defineDocs({
  sections: [],
  // @ts-expect-error — 'otel' is in no group
  groups: [{ title: 'Core', packages: ['core', 'cli', 'create-marmeon', 'log', 'encryption', 'testing', 'router', 'validation', 'http', 'server', 'session', 'vite', 'i18n', 'database', 'cache', 'redis', 'auth', 'mail', 'notifications', 'queue', 'scheduler', 'storage', 'live', 'table', 'react', 'devtools'] }],
});

defineDocs({
  sections: [],
  groups: [
    // @ts-expect-error — 'sheduler' is no package
    { title: 'Core', packages: ['core', 'cli', 'create-marmeon', 'log', 'encryption', 'testing', 'router', 'validation', 'http', 'server', 'session', 'vite', 'i18n', 'database', 'cache', 'redis', 'auth', 'mail', 'notifications', 'queue', 'sheduler', 'storage', 'live', 'table', 'react', 'devtools', 'otel'] },
  ],
});

defineDocs({
  sections: [{ title: 'Prologue', pages: [{ slug: 'upgrading', label: 'Upgrade Guide', file: 'UPGRADING.md', changes: true }] }],
  groups: [
    {
      title: 'Core',
      packages: ['core', 'cli', 'create-marmeon', 'log', 'encryption', 'testing', 'router', 'validation', 'http', 'server', 'session', 'vite', 'i18n', 'database', 'cache', 'redis', 'auth', 'mail', 'notifications', 'queue', 'scheduler', 'storage', 'live', 'table', 'react', 'devtools', 'otel'],
    },
  ],
});

// @ts-expect-error — the sections are required (the docs are their pages)
defineDocs({
  groups: [
    {
      title: 'Core',
      packages: ['core', 'cli', 'create-marmeon', 'log', 'encryption', 'testing', 'router', 'validation', 'http', 'server', 'session', 'vite', 'i18n', 'database', 'cache', 'redis', 'auth', 'mail', 'notifications', 'queue', 'scheduler', 'storage', 'live', 'table', 'react', 'devtools', 'otel'],
    },
  ],
});
