import { authenticate, verified } from '@marmeon/auth';
import { throttle } from '@marmeon/cache';
import { defineRoutes, everyone } from '@marmeon/http';
import { RequestAccountExportController } from './controllers/RequestAccountExportController.ts';
import { ShowAccountExportController } from './controllers/ShowAccountExportController.ts';

export default defineRoutes((Route) => {
  // Signed in, with a confirmed address. Both routes act on the signed-in account (`ctx.user`) and take no id from the path,
  // so there is no record to authorize.
  const account = Route.prefix('/account/export').middleware(authenticate()).middleware(verified()).authorize(everyone).name('account-export.');
  account.get('/', ShowAccountExportController).name('show');
  // Three requests an hour for each user; AccountExportServiceProvider defines the limiter.
  account.middleware(throttle('account-export')).post('/', RequestAccountExportController).name('request');
});
