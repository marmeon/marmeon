import { defineModule } from '@marmeon/core';
import { AccountExportServiceProvider } from './AccountExportServiceProvider.ts';
import { SendAccountExportJob } from './jobs/SendAccountExportJob.ts';
import routes from './routes.ts';

export default defineModule({
  name: 'account-export',
  jobs: [SendAccountExportJob],
  providers: [AccountExportServiceProvider],
  routes,
});
