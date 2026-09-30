import { Router } from '@bespokecore/router';
import { routes as userProfileRoutes } from '#modules/user-profile';

/** The application's composition root: every module's routes are registered here. */
export const router = new Router().load(userProfileRoutes);
