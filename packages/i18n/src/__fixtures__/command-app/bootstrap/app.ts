import { join } from 'node:path';
import { defineApplication } from '@marmeon/core';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { CliServiceProvider } from 'marmeon';
import { I18nServiceProvider } from '../../../index.ts';
import { GreetCommand } from '../commands.ts';

// A minimal app for `i18n.test.ts`: a command whose constructor takes the request-scoped Translator.
export default defineApplication({
  root: join(import.meta.dirname, '..'),
  discover: false,
  env: { APP_KEY: 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=', APP_LOCALE: 'de', APP_LOCALES: 'de,en' },
  providers: [CliServiceProvider, EncryptionServiceProvider, HttpServiceProvider, I18nServiceProvider],
  modules: [{ name: 'fixture', commands: [GreetCommand] }],
});
