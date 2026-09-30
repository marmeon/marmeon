import { join } from 'node:path';
import { Container, loadDiscoveredPackages, registerProviders } from '@bespokecore/core';
import { Router } from '@bespokecore/router';
import { routes as authRoutes, UserRepository } from '#modules/auth';
import { routes as userProfileRoutes } from '#modules/user-profile';

/** The application's composition root. `createApplication` takes this over in step 5. */
export const container = new Container().singleton(UserRepository);

// Installed packages register themselves — `pnpm add` is all it takes (like Laravel's package:discover).
const discovered = await loadDiscoveredPackages({ root: join(import.meta.dirname, '..') });
registerProviders(container, discovered.providers);

export const router = new Router().load(authRoutes, userProfileRoutes);
