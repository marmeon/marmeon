import { join } from 'node:path';
import { CacheServiceProvider } from '@bespokecore/cache';
import { CliServiceProvider } from '@bespokecore/cli';
import { defineApplication } from '@bespokecore/core';
import { DatabaseServiceProvider } from '@bespokecore/database';
import { RedisServiceProvider } from '@bespokecore/redis';
import { QueueServiceProvider } from '../../../index.ts';
import { DispatchCommand, fixtureJobs } from '../jobs.ts';

// A minimal app for the worker processes of `worker-processes.test.ts`: `bespoke queue:work` runs in it for real. The
// database, queue and cache come from the environment (DB_*, QUEUE_CONNECTION, CACHE_DRIVER, REDIS_*), like any app's.
export default defineApplication({
  root: join(import.meta.dirname, '..'),
  discover: false,
  providers: [CliServiceProvider, DatabaseServiceProvider, RedisServiceProvider, CacheServiceProvider, QueueServiceProvider],
  modules: [{ name: 'fixture', jobs: fixtureJobs, commands: [DispatchCommand] }],
});
