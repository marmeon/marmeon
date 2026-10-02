import { join } from 'node:path';
import { CliServiceProvider } from '@bespokecore/cli';
import { defineApplication } from '@bespokecore/core';
import { DatabaseServiceProvider } from '@bespokecore/database';
import { QueueServiceProvider } from '../../../index.ts';
import { fixtureJobs } from '../jobs.ts';

// A minimal app for the worker processes of `worker-processes.test.ts`: `bespoke queue:work` runs in it for real. The
// database comes from the environment (DB_CONNECTION, DB_DATABASE / DB_URL), like any app's.
export default defineApplication({
  root: join(import.meta.dirname, '..'),
  discover: false,
  providers: [CliServiceProvider, DatabaseServiceProvider, QueueServiceProvider],
  modules: [{ name: 'fixture', jobs: fixtureJobs }],
});
