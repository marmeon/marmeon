import { join } from 'node:path';
import { createApplication } from '@bespokecore/core';
import auth from '#modules/auth';
import { AppConfig } from '../config/app.ts';
import userProfile from '#modules/user-profile';

/**
 * The composition root. Installed packages (including the framework's own, like
 * @bespokecore/http) register themselves through discovery; modules are listed here.
 */
export const app = await createApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig],
  modules: [auth, userProfile],
});
