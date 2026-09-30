import { Container } from '@bespokecore/core';
import { Router } from '@bespokecore/router';
import { routes as authRoutes, UserRepository } from '#modules/auth';
import { routes as userProfileRoutes } from '#modules/user-profile';

/** The application's composition root. Service providers take this over in step 5. */
export const container = new Container().singleton(UserRepository);

export const router = new Router().load(authRoutes, userProfileRoutes);
