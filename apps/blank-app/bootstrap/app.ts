import { join } from 'node:path';
import { defineApplication } from '@bespokecore/core';
import { AppConfig } from '../config/app.ts';

/** A new app: no modules yet. `bespoke make:auth` adds the auth module here. */
export default defineApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig],
  modules: [],
});
