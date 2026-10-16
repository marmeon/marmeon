import { join } from 'node:path';
import { defineApplication } from '@marmeon/core';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { CliServiceProvider } from 'marmeon';
import { I18nServiceProvider } from '../../../index.ts';
import { GreetCommand } from '../commands.ts';

// A minimal app for `i18n.test.ts`: a command whose constructor takes the request-scoped Translator. The test stubs its environment: a definition carries none.
export default defineApplication({
  root: join(import.meta.dirname, '..'),
  discover: false,
  providers: [CliServiceProvider, EncryptionServiceProvider, HttpServiceProvider, I18nServiceProvider],
  modules: [{ name: 'fixture', commands: [GreetCommand] }],
});
