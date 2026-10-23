import { join } from 'node:path';
import { CacheServiceProvider } from '@marmeon/cache';
import { CliServiceProvider } from 'marmeon';
import { defineApplication } from '@marmeon/core';
import { DatabaseServiceProvider } from '@marmeon/database';
import { RedisServiceProvider } from '@marmeon/redis';
import { QueueServiceProvider } from '../../../index.ts';
import { DispatchCommand, fixtureJobs } from '../jobs.ts';

// A minimal app for the worker processes of `worker-processes.test.ts`: `marmeon queue:work` runs in it for real. The
// database, queue and cache come from the environment (DB_*, QUEUE_DRIVER, CACHE_DRIVER, REDIS_*), like any app's.
export default defineApplication({
  root: join(import.meta.dirname, '..'),
  discover: false,
  providers: [CliServiceProvider, DatabaseServiceProvider, RedisServiceProvider, CacheServiceProvider, QueueServiceProvider],
  modules: [{ name: 'fixture', jobs: fixtureJobs, commands: [DispatchCommand] }],
});
