import { defineDocs } from '../../docs.config.ts';

// docs.config.ts is typed against the packages: a name that is none, or a package left out, is a compile error.
defineDocs({
  groups: [
    {
      title: 'Core',
      packages: ['core', 'cli', 'log', 'encryption', 'testing', 'router', 'http', 'server', 'session', 'vite', 'i18n', 'database', 'cache', 'redis', 'auth', 'mail', 'notifications', 'queue', 'scheduler', 'storage', 'live', 'react', 'devtools', 'otel'],
    },
  ],
});

defineDocs({
  // @ts-expect-error — 'otel' is in no group
  groups: [{ title: 'Core', packages: ['core', 'cli', 'log', 'encryption', 'testing', 'router', 'http', 'server', 'session', 'vite', 'i18n', 'database', 'cache', 'redis', 'auth', 'mail', 'notifications', 'queue', 'scheduler', 'storage', 'live', 'react', 'devtools'] }],
});

defineDocs({
  groups: [
    // @ts-expect-error — 'sheduler' is no package
    { title: 'Core', packages: ['core', 'cli', 'log', 'encryption', 'testing', 'router', 'http', 'server', 'session', 'vite', 'i18n', 'database', 'cache', 'redis', 'auth', 'mail', 'notifications', 'queue', 'sheduler', 'storage', 'live', 'react', 'devtools', 'otel'] },
  ],
});
