import { join } from 'node:path';
import { defineApplication } from '@bespokecore/core';
import auth from '#modules/auth';
import userProfile from '#modules/user-profile';
import { AppConfig } from '../config/app.ts';

/**
 * The composition root. It only describes the app: `bespoke` boots it, and tests
 * boot a fresh instance per test. Installed packages (including the framework's
 * own, like @bespokecore/http) register themselves through discovery.
 */
export default defineApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig],
  modules: [auth, userProfile],
});
