import { defineModule } from '@marmeon/core';
import { PaymentsConfig } from './config.ts';
import { IssueReceiptJob } from './jobs/IssueReceiptJob.ts';
import { PaymentsServiceProvider } from './PaymentsServiceProvider.ts';
import routes from './routes.ts';

export default defineModule({
  name: 'payments',
  config: [PaymentsConfig],
  jobs: [IssueReceiptJob],
  migrations: new URL('./migrations/', import.meta.url),
  providers: [PaymentsServiceProvider],
  routes,
});
